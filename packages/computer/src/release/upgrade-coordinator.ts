import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";

import {
  ComputerUpdater,
  UpdateError,
  type LockedComputerUpdater,
  type PreparedUpdate,
} from "#src/updater";
import {
  createSupervisorUpgradeLifecycle,
  type ManagedRuntimeSnapshot,
  type UpgradeLifecycle,
} from "./upgrade-lifecycle";
import {
  assertUpgradeRequestId,
  type UpgradeOperation,
  type UpgradeOperationKind,
} from "./upgrade-operation";

export type { UpgradeOperation, UpgradeOperationKind };

/** Where one machine keeps its installation, its release feed, and its Coordinator. */
export interface UpgradeCoordinatorPaths {
  installRoot: string;
  binaryDirectory?: string;
  target: string;
  baseUrl: string;
  supervisorSocketPath: string;
  supervisorStatePath: string;
  serviceName?: string;
  homeDirectory?: string;
  runtimeHomeDirectory?: string;
}

export type UpgradeCoordinatorOptions = UpgradeOperation &
  UpgradeCoordinatorPaths & {
    lifecycle?: UpgradeLifecycle;
    updater?: Pick<ComputerUpdater, "withExclusiveOperation">;
  };

/** The durable receipt one operation leaves behind; the only evidence the Daemon reads. */
export type UpgradeResult = {
  schema_version: 1;
  request_id: string;
  operation: UpgradeOperationKind;
  status: "succeeded" | "failed";
  version?: string;
  restoredVersion?: string;
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. Set when this machine can name a stable reason: the updater's own
   * `UpdateError.code` when the failure happened before any switch, or a generic rollback-outcome
   * code once one was attempted. */
  errorCode?: string;
  /** Whether the Computer supervisor was running before the switch. Kept JSON-plain so a CLI
   * reading the receipt back can tell a caller their Workspaces were never touched. */
  supervisorRunning?: boolean;
  runtimes?: { bindingId: string; running: boolean }[];
};

export class UpgradeCoordinatorError extends Error {
  constructor(
    message: string,
    readonly result: UpgradeResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpgradeCoordinatorError";
  }
}

export type CommitUpgradeResult = (result: UpgradeResult) => Promise<void>;

export async function coordinateUpgrade(
  options: UpgradeCoordinatorOptions,
  onStage: (stage: string) => void = () => {},
  commitResult: CommitUpgradeResult = async () => {},
): Promise<UpgradeResult> {
  assertUpgradeRequestId(options.requestId);
  const updater =
    options.updater ??
    new ComputerUpdater({
      installRoot: options.installRoot,
      binaryDirectory: options.binaryDirectory,
      target: options.target,
      baseUrl: options.baseUrl,
      localDirectory: options.localDirectory,
      quietHeader: options.quiet,
      onStage,
    });
  const lifecycle =
    options.lifecycle ??
    createSupervisorUpgradeLifecycle({
      installRoot: options.installRoot,
      supervisorSocketPath: options.supervisorSocketPath,
      supervisorStatePath: options.supervisorStatePath,
      serviceName: options.serviceName,
      homeDirectory: options.homeDirectory,
      runtimeHomeDirectory: options.runtimeHomeDirectory,
    });
  return updater.withExclusiveOperation(async (lockedUpdater) => {
    const prepared =
      options.operation === "rollback"
        ? await lockedUpdater.prepareRollback()
        : await lockedUpdater.prepare(options.selection);
    onStage("Pausing new Workspace launches");
    await lifecycle.pauseLaunches(options.requestId);
    let snapshot: ManagedRuntimeSnapshot;
    try {
      snapshot = await lifecycle.snapshot();
    } catch (error) {
      await lifecycle.resumeLaunches(options.requestId);
      throw error;
    }
    return await switchRuntime(
      lifecycle,
      lockedUpdater,
      snapshot,
      prepared,
      options,
      onStage,
      commitResult,
    );
  });
}

/** How many bindings this snapshot has running, versus registered-but-stopped. */
function runtimeCounts(snapshot: ManagedRuntimeSnapshot): { running: number; stopped: number } {
  const running = snapshot.bindings.filter((binding) => binding.running).length;
  return { running, stopped: snapshot.bindings.length - running };
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

/** The `==>` stage wording for one stop/activate/start/probe/healthy switch, shared by the
 * candidate path and the restore path. When the supervisor was not running before the switch,
 * there is no process tree to stop or start, so those stages collapse into a single fact and the
 * probe is described as checking the activated executable rather than a live supervisor.
 *
 * When `restartsInPlace` is true (launchd), `lifecycle.stop()` never actually stops
 * anything - it only checks the label can be restarted - so there is no truthful "stopping" stage
 * to print before the switch; and `lifecycle.start()` kickstarts the already-running job rather
 * than starting a fresh one, hence "Restarting" rather than "Starting". */
function switchStageText(snapshot: ManagedRuntimeSnapshot, restartsInPlace: boolean) {
  const { running, stopped } = runtimeCounts(snapshot);
  return {
    stopping: !snapshot.supervisorRunning
      ? "Computer supervisor is not running; no processes to restart"
      : restartsInPlace
        ? undefined
        : `Stopping Computer supervisor and ${running} Workspace runtime${plural(running)}`,
    switching: (version: string) => `Switching the active executable to ${version}`,
    starting: (version: string) => {
      if (!snapshot.supervisorRunning) return undefined;
      const verb = restartsInPlace
        ? "Restarting Computer supervisor as"
        : "Starting Computer supervisor";
      return `${verb} ${version}; Workspace launches remain held (${running} to resume, ${stopped} stay stopped)`;
    },
    waiting: (version: string) =>
      snapshot.supervisorRunning
        ? `Waiting for the Computer supervisor to report ${version}`
        : `Checking the activated executable reports ${version}`,
    healthy: (version: string) =>
      snapshot.supervisorRunning
        ? `Computer supervisor ${version} healthy; Workspace launches remain held`
        : `Activated executable ${version} confirmed`,
  };
}

/** Stops (if running), activates one version, starts it back up (if it was running), and waits
 * for it to report healthy. Used for both the candidate switch and, on candidate failure, the
 * restore back to the previous version. For a `restartsInPlace` lifecycle this is really
 * check → activate → kickstart → probe; `lifecycle.stop`/`lifecycle.start` and
 * `switchStageText` carry that distinction so this function's shape stays the same for both. */
async function performSwitch(
  lifecycle: UpgradeLifecycle,
  snapshot: ManagedRuntimeSnapshot,
  version: string,
  activate: () => Promise<void>,
  onStage: (stage: string) => void,
): Promise<void> {
  const stage = switchStageText(snapshot, lifecycle.restartsInPlace);
  if (stage.stopping) onStage(stage.stopping);
  await lifecycle.stop(snapshot);
  onStage(stage.switching(version));
  await activate();
  const startStage = stage.starting(version);
  if (startStage) onStage(startStage);
  await lifecycle.start(snapshot, version);
  onStage(stage.waiting(version));
  await lifecycle.probe(snapshot, { version });
  onStage(stage.healthy(version));
}

async function switchRuntime(
  lifecycle: UpgradeLifecycle,
  updater: Pick<LockedComputerUpdater, "activatePrepared" | "restoreVerified">,
  snapshot: ManagedRuntimeSnapshot,
  prepared: PreparedUpdate,
  { requestId: request_id, operation }: Pick<UpgradeOperation, "requestId" | "operation">,
  onStage: (stage: string) => void,
  commitResult: CommitUpgradeResult,
): Promise<UpgradeResult> {
  let committedResult: UpgradeResult | undefined;
  try {
    // Quiesce before the switch, never after: for a stop-then-start lifecycle, `stop` runs the
    // ~2s SIGTERM/SIGKILL ladder this hold exists to keep away from a live tool call. For a
    // lifecycle that restarts in place, that same ladder runs inside the later
    // `start`'s kickstart instead, but the hold must still be in place before it - only where it
    // runs moved, not whether it needs to happen first. The rollback `stop` below is
    // deliberately not held either way - that path is already a failure recovery and speed wins
    // there.
    if (snapshot.supervisorRunning) onStage("Holding Agent runners until they are idle");
    await lifecycle.holdRunners();
    await performSwitch(
      lifecycle,
      snapshot,
      prepared.version,
      () => updater.activatePrepared(prepared),
      onStage,
    );
    const result: UpgradeResult = {
      schema_version: 1,
      request_id,
      operation,
      status: "succeeded",
      version: prepared.version,
      supervisorRunning: snapshot.supervisorRunning,
      runtimes: snapshot.bindings.map((binding) => ({
        bindingId: binding.bindingId,
        running: binding.running,
      })),
    };
    onStage("Recording the terminal upgrade result before Workspace launch");
    await commitResult(result);
    committedResult = result;
    onStage("Resuming Workspace launches");
    await lifecycle.resumeLaunches(request_id);
    return result;
  } catch (candidateError) {
    // The Computer version is already durably committed. A later Workspace recovery failure is
    // surfaced by the Workspace lifecycle and must not rewrite that result or roll bytes back.
    if (committedResult)
      throw new UpgradeCoordinatorError(
        "candidate committed; Workspace recovery failed",
        committedResult,
        { cause: candidateError },
      );

    if (prepared.previous === null) {
      const result: UpgradeResult = {
        schema_version: 1,
        request_id,
        operation,
        status: "failed",
        error: errorMessage(candidateError),
      };
      try {
        await commitResult(result);
      } catch (commitError) {
        throw new UpgradeCoordinatorError(
          "candidate failed with no rollback version and result commit failed",
          result,
          { cause: commitError },
        );
      }
      // No verified version exists to resume. Retain launch-hold for explicit recovery.
      throw new UpgradeCoordinatorError("candidate failed with no rollback version", result, {
        cause: candidateError,
      });
    }

    try {
      onStage(`Upgrade failed: ${errorMessage(candidateError)}; restoring ${prepared.previous}`);
      await performSwitch(
        lifecycle,
        snapshot,
        prepared.previous,
        () => updater.restoreVerified(prepared.previous!, prepared.rollbackVersion ?? null),
        onStage,
      );
    } catch (rollbackError) {
      // Neither version has verified health: record the precise terminal failure and retain
      // launch-hold for explicit recovery.
      const result: UpgradeResult = {
        schema_version: 1,
        request_id,
        operation,
        status: "failed",
        error: `${errorMessage(candidateError)}; rollback failed: ${errorMessage(rollbackError)}`,
        errorCode: UPGRADE_ERROR_CODE.ROLLBACK_FAILED,
      };
      try {
        await commitResult(result);
      } catch (commitError) {
        throw new UpgradeCoordinatorError(
          "candidate and rollback failed; result commit failed",
          result,
          { cause: commitError },
        );
      }
      throw new UpgradeCoordinatorError("candidate and rollback failed", result, {
        cause: rollbackError,
      });
    }

    const result: UpgradeResult = {
      schema_version: 1,
      request_id,
      operation,
      status: "failed",
      restoredVersion: prepared.previous,
      error: errorMessage(candidateError),
      errorCode: UPGRADE_ERROR_CODE.ROLLED_BACK,
    };
    onStage("Recording the rollback result before Workspace launch");
    try {
      await commitResult(result);
    } catch (commitError) {
      throw new UpgradeCoordinatorError(
        "previous version restored but result commit failed",
        result,
        { cause: commitError },
      );
    }
    onStage("Resuming Workspace launches");
    try {
      await lifecycle.resumeLaunches(request_id);
    } catch (resumeError) {
      throw new UpgradeCoordinatorError(
        "previous version restored; Workspace recovery failed",
        result,
        { cause: resumeError },
      );
    }
    onStage(`Previous version ${prepared.previous} restored and healthy`);
    throw new UpgradeCoordinatorError("candidate failed; previous version restored", result, {
      cause: candidateError,
    });
  }
}

type CoordinatorRequest = Omit<UpgradeCoordinatorOptions, "lifecycle" | "updater"> & {
  resultPath: string;
};

export async function runUpgradeCoordinator(args: string[]): Promise<void> {
  const requestFlag = args.indexOf("--request");
  if (requestFlag < 0 || !args[requestFlag + 1]) throw new Error("missing --request path");
  const requestPath = args[requestFlag + 1]!;
  const request = JSON.parse(await readFile(requestPath, "utf8")) as CoordinatorRequest;
  // The durable request file is the only carrier of the operation's identity between processes.
  assertUpgradeRequestId(request.requestId);
  // A terminal receipt is write-once. `coordinateUpgrade` commits it before releasing
  // launch-hold; the final call below only covers failures that happened before switchRuntime
  // could construct a terminal result (prepare/snapshot, for example).
  let committedResult: UpgradeResult | undefined;
  const commitResult: CommitUpgradeResult = async (result) => {
    if (committedResult) {
      if (JSON.stringify(committedResult) !== JSON.stringify(result))
        throw new Error("attempted to overwrite a committed upgrade result");
      return;
    }
    await writeJsonAtomic(request.resultPath, result);
    committedResult = result;
  };
  let result: UpgradeResult;
  let workspaceRecoveryFailed = false;
  try {
    result = await coordinateUpgrade(request, (stage) => console.log(`==> ${stage}`), commitResult);
  } catch (error) {
    if (error instanceof UpgradeCoordinatorError) {
      result = error.result;
      workspaceRecoveryFailed = /Workspace recovery failed/.test(error.message);
    } else {
      result = {
        schema_version: 1,
        request_id: request.requestId,
        operation: request.operation,
        status: "failed",
        error: errorMessage(error),
        ...(error instanceof UpdateError ? { errorCode: error.code } : {}),
      };
    }
  }
  await commitResult(result);
  // The caller reports the durable error; an uncaught throw would dump a second stack trace.
  // Succeeded bytes with incomplete Workspace recovery still exit non-zero so the CLI does not
  // claim a clean install while launches remain held or children failed to start.
  if (result.status === "failed" || workspaceRecoveryFailed) process.exitCode = 1;
}

export interface LaunchUpgradeCoordinatorPaths extends UpgradeCoordinatorPaths {
  executablePath?: string;
}

/** Where one operation's durable request and result receipts live. */
export function upgradeReceiptPaths(installRoot: string, requestId: string) {
  assertUpgradeRequestId(requestId);
  const directory = join(installRoot, "upgrade-results");
  return {
    directory,
    requestPath: join(directory, `${requestId}.request.json`),
    resultPath: join(directory, `${requestId}.result.json`),
  };
}

/** Starts an OS-detached copy of the unified executable from the normal CLI. Linux rejects calls
 * from the managed supervisor unit because all descendants share its stop scope. Completion is
 * observed through a private durable result file rather than inherited pipes. */
export async function launchUpgradeCoordinator(
  operation: UpgradeOperation,
  paths: LaunchUpgradeCoordinatorPaths,
): Promise<UpgradeResult> {
  await assertCoordinatorOutsideManagedSupervisor();
  assertUpgradeRequestId(operation.requestId);
  const { directory, requestPath, resultPath } = upgradeReceiptPaths(
    paths.installRoot,
    operation.requestId,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { executablePath = process.execPath, ...requestPaths } = paths;
  await writeJsonAtomic(requestPath, { ...operation, ...requestPaths, resultPath });
  const child = Bun.spawn({
    cmd: [executablePath, "__upgrade", "--request", requestPath],
    stdin: "ignore",
    // Completion still uses the durable result, never terminal output. Normal CLI upgrades
    // inherit stdout so their installation progress remains visible; a remote operation runs
    // with no terminal at all.
    stdout: operation.origin === "remote" ? "ignore" : "inherit",
    stderr: "inherit",
    detached: true,
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 10 * 60_000;
  while (!(await Bun.file(resultPath).exists())) {
    if (child.exitCode !== null) throw new Error("upgrade coordinator exited without a result");
    if (Date.now() >= deadline)
      throw new Error(
        `upgrade completion is unknown; coordinator may still be running; inspect ${resultPath}`,
      );
    await Bun.sleep(50);
  }
  const result = JSON.parse(await readFile(resultPath, "utf8")) as UpgradeResult;
  if (result.status === "failed") throw new UpgradeCoordinatorError(result.error!, result);
  // A succeeded receipt can still pair with exit 1 when Workspace recovery failed after commit.
  // Wait for the process so that incomplete recovery is not reported as a clean CLI success.
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new UpgradeCoordinatorError("candidate committed; Workspace recovery failed", result);
  return result;
}

async function assertCoordinatorOutsideManagedSupervisor(): Promise<void> {
  if (process.platform !== "linux") return;
  const cgroup = await Bun.file("/proc/self/cgroup")
    .text()
    .catch(() => "");
  if (cgroup.includes("coforge-daemon.service"))
    throw new Error(
      "Upgrade must be started from a normal terminal, not from inside coforge-daemon.service, because stopping the service would terminate its coordinator.",
    );
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
