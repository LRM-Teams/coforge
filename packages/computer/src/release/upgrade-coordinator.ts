import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ComputerUpdater, type LockedComputerUpdater, type PreparedUpdate } from "../updater";
import {
  createSupervisorUpgradeLifecycle,
  type ManagedRuntimeSnapshot,
  type UpgradeLifecycle,
} from "./upgrade-lifecycle";

export type UpgradeOperation = "upgrade" | "rollback";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface UpgradeCoordinatorOptions {
  requestId?: string;
  installRoot: string;
  binaryDirectory?: string;
  localDirectory?: string;
  quietHeader?: boolean;
  target: string;
  baseUrl: string;
  selection: string;
  operation: UpgradeOperation;
  supervisorSocketPath: string;
  supervisorStatePath: string;
  serviceName?: string;
  homeDirectory?: string;
  runtimeHomeDirectory?: string;
  lifecycle?: UpgradeLifecycle;
  updater?: Pick<ComputerUpdater, "withExclusiveOperation">;
}

export type UpgradeResult = {
  schema_version: 1;
  operation: UpgradeOperation;
  status: "succeeded" | "failed";
  version?: string;
  restoredVersion?: string;
  error?: string;
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
  const requestId = options.requestId ?? Bun.env.COFORGE_UPGRADE_REQUEST_ID;
  if (requestId !== undefined && !UUID_PATTERN.test(requestId))
    throw new Error("COFORGE_UPGRADE_REQUEST_ID must be a valid UUID");
  const updater =
    options.updater ??
    new ComputerUpdater({
      installRoot: options.installRoot,
      binaryDirectory: options.binaryDirectory,
      target: options.target,
      baseUrl: options.baseUrl,
      localDirectory: options.localDirectory,
      quietHeader: options.quietHeader,
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
    await lifecycle.pauseLaunches();
    let snapshot: ManagedRuntimeSnapshot;
    try {
      snapshot = await lifecycle.snapshot();
    } catch (error) {
      await lifecycle.resumeLaunches();
      throw error;
    }
    return await switchRuntime(
      lifecycle,
      lockedUpdater,
      snapshot,
      prepared,
      options.operation,
      onStage,
    );
  });
}

async function switchRuntime(
  lifecycle: UpgradeLifecycle,
  updater: Pick<LockedComputerUpdater, "activatePrepared" | "restoreVerified">,
  snapshot: ManagedRuntimeSnapshot,
  prepared: PreparedUpdate,
  operation: UpgradeOperation,
  onStage: (stage: string) => void,
): Promise<UpgradeResult> {
  const oldProcessIds = snapshot.bindings
    .filter((binding) => binding.running && binding.processId !== null)
    .map((binding) => binding.processId!);
  let paused = true;
  try {
    await lifecycle.stop(snapshot);
    await updater.activatePrepared(prepared);
    await lifecycle.start(snapshot, prepared.version);
    await lifecycle.probe(snapshot, {
      version: prepared.version,
      previousProcessIds: oldProcessIds,
    });
    await lifecycle.resumeLaunches();
    paused = false;
    return { schema_version: 1, operation, status: "succeeded", version: prepared.version };
  } catch (candidateError) {
    if (!paused || prepared.previous === null) {
      if (paused) await lifecycle.resumeLaunches().catch(() => {});
      throw candidateError;
    }
    try {
      onStage(`Upgrade failed; restoring ${prepared.previous}`);
      await lifecycle.stop(snapshot);
      await updater.restoreVerified(prepared.previous, prepared.rollbackVersion ?? null);
      await lifecycle.start(snapshot, prepared.previous);
      await lifecycle.probe(snapshot, {
        version: prepared.previous,
        previousProcessIds: oldProcessIds,
      });
      await lifecycle.resumeLaunches();
      onStage(`Previous version ${prepared.previous} restored and healthy`);
      const result: UpgradeResult = {
        schema_version: 1,
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
  if (request.requestId !== undefined && !UUID_PATTERN.test(request.requestId))
    throw new Error("upgrade coordinator request ID must be a valid UUID");
  let result: UpgradeResult;
  try {
    result = await coordinateUpgrade(request, (stage) => console.log(`==> ${stage}`));
  } catch (error) {
    result =
      error instanceof UpgradeCoordinatorError
        ? error.result
        : {
            schema_version: 1,
            operation: request.operation,
            status: "failed",
            error: errorMessage(error),
          };
  }
  await writeJsonAtomic(request.resultPath, result);
  // The caller reports the durable error; an uncaught throw would dump a second stack trace.
  if (result.status === "failed") process.exitCode = 1;
}

export interface LaunchUpgradeCoordinatorOptions extends Omit<
  UpgradeCoordinatorOptions,
  "lifecycle" | "updater"
> {
  executablePath?: string;
  /** Remote-triggered upgrades suppress terminal progress; normal CLI upgrades show it. */
  quietProgress?: boolean;
}

/** Starts an OS-detached copy of the unified executable from the normal CLI. Linux rejects calls
 * from the managed supervisor unit because all descendants share its stop scope. Completion is
 * observed through a private durable result file rather than inherited pipes. */
export async function launchUpgradeCoordinator(
  options: LaunchUpgradeCoordinatorOptions,
): Promise<UpgradeResult> {
  await assertCoordinatorOutsideManagedSupervisor();
  const id = options.requestId ?? Bun.env.COFORGE_UPGRADE_REQUEST_ID ?? crypto.randomUUID();
  if (!UUID_PATTERN.test(id))
    throw new Error("upgrade coordinator request ID must be a valid UUID");
  const directory = join(options.installRoot, "upgrade-results");
  const requestPath = join(directory, `${id}.request.json`);
  const resultPath = join(directory, `${id}.result.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { executablePath = process.execPath, ...requestOptions } = options;
  await writeJsonAtomic(requestPath, { ...requestOptions, resultPath });
  const child = Bun.spawn({
    cmd: [executablePath, "__upgrade", "--request", requestPath],
    stdin: "ignore",
    // Completion still uses the durable result, never terminal output. Normal CLI upgrades
    // inherit stdout so their installation progress remains visible; the remote hidden path
    // opts into quiet progress explicitly.
    stdout: options.quietProgress ? "ignore" : "inherit",
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
