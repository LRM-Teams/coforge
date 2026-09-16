import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ComputerUpdater, type LockedComputerUpdater, type PreparedUpdate } from "../updater";
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

export async function coordinateUpgrade(
  options: UpgradeCoordinatorOptions,
  onStage: (stage: string) => void = () => {},
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
    await lifecycle.pauseLaunches();
    let snapshot: ManagedRuntimeSnapshot;
    try {
      snapshot = await lifecycle.snapshot();
    } catch (error) {
      await lifecycle.resumeLaunches();
      throw error;
    }
    return await switchRuntime(lifecycle, lockedUpdater, snapshot, prepared, options, onStage);
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
 * probe is described as checking the activated executable rather than a live supervisor. */
function switchStageText(snapshot: ManagedRuntimeSnapshot) {
  const { running, stopped } = runtimeCounts(snapshot);
  return {
    stopping: snapshot.supervisorRunning
      ? `Stopping Computer supervisor and ${running} Workspace runtime${plural(running)}`
      : "Computer supervisor is not running; no processes to restart",
    switching: (version: string) => `Switching the active executable to ${version}`,
    starting: (version: string) =>
      snapshot.supervisorRunning
        ? `Starting Computer supervisor ${version} (${running} running Workspace runtime${plural(running)}, ${stopped} stopped Workspace binding${plural(stopped)} left as is)`
        : undefined,
    waiting: (version: string) =>
      snapshot.supervisorRunning
        ? `Waiting for the supervisor and Workspace runtimes to report ${version}`
        : `Checking the activated executable reports ${version}`,
    healthy: (version: string) =>
      snapshot.supervisorRunning
        ? `Computer supervisor ${version} healthy with ${running} Workspace runtime${plural(running)}`
        : `Activated executable ${version} confirmed`,
  };
}

/** Stops (if running), activates one version, starts it back up (if it was running), and waits
 * for it to report healthy. Used for both the candidate switch and, on candidate failure, the
 * restore back to the previous version. */
async function performSwitch(
  lifecycle: UpgradeLifecycle,
  snapshot: ManagedRuntimeSnapshot,
  version: string,
  activate: () => Promise<void>,
  previousProcessIds: readonly number[],
  onStage: (stage: string) => void,
): Promise<void> {
  const stage = switchStageText(snapshot);
  onStage(stage.stopping);
  await lifecycle.stop(snapshot);
  onStage(stage.switching(version));
  await activate();
  const startStage = stage.starting(version);
  if (startStage) onStage(startStage);
  await lifecycle.start(snapshot, version);
  onStage(stage.waiting(version));
  await lifecycle.probe(snapshot, { version, previousProcessIds });
  onStage(stage.healthy(version));
}

async function switchRuntime(
  lifecycle: UpgradeLifecycle,
  updater: Pick<LockedComputerUpdater, "activatePrepared" | "restoreVerified">,
  snapshot: ManagedRuntimeSnapshot,
  prepared: PreparedUpdate,
  { requestId: request_id, operation }: Pick<UpgradeOperation, "requestId" | "operation">,
  onStage: (stage: string) => void,
): Promise<UpgradeResult> {
  const oldProcessIds = snapshot.bindings
    .filter((binding) => binding.running && binding.processId !== null)
    .map((binding) => binding.processId!);
  let paused = true;
  try {
    // Quiesce before the stop, never after: `stop` is the ~2s SIGTERM/SIGKILL ladder this hold
    // exists to keep away from a live tool call (ADR 0020). The rollback `stop` below is
    // deliberately not held - that path is already a failure recovery and speed wins there.
    if (snapshot.supervisorRunning) onStage("Holding Agent runners until they are idle");
    await lifecycle.holdRunners();
    await performSwitch(
      lifecycle,
      snapshot,
      prepared.version,
      () => updater.activatePrepared(prepared),
      oldProcessIds,
      onStage,
    );
    onStage("Resuming Workspace launches");
    await lifecycle.resumeLaunches();
    paused = false;
    return {
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
  } catch (candidateError) {
    if (!paused || prepared.previous === null) {
      if (paused) await lifecycle.resumeLaunches().catch(() => {});
      throw candidateError;
    }
    try {
      onStage(`Upgrade failed: ${errorMessage(candidateError)}; restoring ${prepared.previous}`);
      await performSwitch(
        lifecycle,
        snapshot,
        prepared.previous,
        () => updater.restoreVerified(prepared.previous!, prepared.rollbackVersion ?? null),
        oldProcessIds,
        onStage,
      );
      onStage("Resuming Workspace launches");
      await lifecycle.resumeLaunches();
      onStage(`Previous version ${prepared.previous} restored and healthy`);
      const result: UpgradeResult = {
        schema_version: 1,
        request_id,
        operation,
        status: "failed",
        restoredVersion: prepared.previous,
        error: errorMessage(candidateError),
      };
      throw new UpgradeCoordinatorError("candidate failed; previous version restored", result, {
        cause: candidateError,
      });
    } catch (rollbackError) {
      if (rollbackError instanceof UpgradeCoordinatorError) throw rollbackError;
      // Neither version has verified health: retain the launch hold for explicit recovery.
      const result: UpgradeResult = {
        schema_version: 1,
        request_id,
        operation,
        status: "failed",
        error: `${errorMessage(candidateError)}; rollback failed: ${errorMessage(rollbackError)}`,
      };
      throw new UpgradeCoordinatorError("candidate and rollback failed", result, {
        cause: rollbackError,
      });
    }
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
  let result: UpgradeResult;
  try {
    result = await coordinateUpgrade(request, (stage) => console.log(`==> ${stage}`));
  } catch (error) {
    result =
      error instanceof UpgradeCoordinatorError
        ? error.result
        : {
            schema_version: 1,
            request_id: request.requestId,
            operation: request.operation,
            status: "failed",
            error: errorMessage(error),
          };
  }
  await writeJsonAtomic(request.resultPath, result);
  // The caller reports the durable error; an uncaught throw would dump a second stack trace.
  if (result.status === "failed") process.exitCode = 1;
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
