import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UPGRADE_ERROR_CODE, type ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { startDaemonLocalRpcServer, type DaemonHoldReport } from "../local-rpc";
import { FileDaemonCredentialStore } from "../credentials/credential-store";
import { DaemonConfigStore } from "../persistence/daemon-config";
import { LocalDaemonLauncher } from "../daemon-host/launcher";
import { acquireProcessLock, isLockContention, type ProcessLock } from "../platform/process-lock";
import {
  MachineSupervisor,
  UPGRADE_OPERATION_PENDING_TTL_MS,
  WorkspaceRecoveryError,
  type BindingStore,
  type ManagedBinding,
} from "./machine-supervisor";
import { FileBindingStore } from "./binding-store";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { configureDaemonLogging } from "../platform/daemon-logging";
import { COFORGE_DAEMON_VERSION } from "../version";
import { SystemdWorkspaceInstance } from "./systemd-workspace-instance";
import { LaunchdWorkspaceInstance } from "./launchd-workspace-instance";
import { workspaceStateDirectory, type WorkspaceInstance } from "./workspace-instance";
import { WorkspaceHealthJournal, workspaceHealthJournalPath } from "./workspace-health-journal";
import { answeredWithin } from "./runner-hold";
import { COFORGE_DAEMON_SERVER_URL } from "../connection/built-server";
import { launchComputerUpgrade } from "../platform/computer-upgrade-launcher";
import { sweepLeftoverComputerUpgradeJobs } from "../platform/computer-upgrade-sweep";
import { UpgradeLaunchFailedError } from "./upgrade-error";
import {
  HeldUpgradeRecovery,
  operationAllowsWorkspaceRecovery,
  resolveHeldRequestId,
  shouldAutoFinishHeldUpgrade,
} from "./held-upgrade-recovery";
import {
  sweepComputerUpgradeReceipts,
  watchComputerUpgradeReceipt,
  type ComputerUpgradeReceipt,
} from "../platform/computer-upgrade-receipts";

/** How often a Coordinator checks for a receipt from a job it is watching. */
const UPGRADE_RECEIPT_POLL_MS = 2_000;

/**
 * How long the Coordinator waits for one Workspace daemon to answer a runner hold. A Workspace
 * that does not answer is reported unreachable and counted as idle: a wedged or dead Workspace
 * daemon must never be able to block a Computer upgrade (ADR 0020) or a restart (ADR 0021).
 */
const RUNNER_HOLD_WORKSPACE_TIMEOUT_MS = 5_000;

export async function runMachineSupervisor(
  args: string[],
  createBindings: (stateDirectory: string) => BindingStore = (directory) =>
    new FileBindingStore(directory, COFORGE_DAEMON_SERVER_URL),
): Promise<void> {
  const socketPath = args[args.indexOf("--socket") + 1];
  if (!args.includes("--socket") || !socketPath) throw new Error("supervisor requires --socket");
  const stateDirectory = args.includes("--state-directory")
    ? args[args.indexOf("--state-directory") + 1]!
    : dirname(socketPath);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await configureDaemonLogging(stateDirectory);
  try {
    await withContext(
      {
        service: "coforge-daemon",
        version: COFORGE_DAEMON_VERSION,
        process_role: "coordinator",
        pid: process.pid,
      },
      async () => {
        const lock = await acquireSupervisorLock(stateDirectory);
        const logger = getLogger(["coforge", "daemon", "supervisor"]);
        try {
          logger.info("Coordinator process started", { event: "coordinator:started" });
          // Best-effort: a leftover one-shot upgrade job never respawns, but it can still hold a
          // stale `launchctl list` entry and plist across restarts until this sweep clears it.
          await sweepLeftoverComputerUpgradeJobs({
            platform: process.platform,
            stateDirectory,
          }).catch((error) =>
            logger.error("Leftover Computer upgrade job sweep failed", {
              event: "upgrade:leftover_job_sweep_failed",
              error_message: error instanceof Error ? error.message : String(error),
            }),
          );
          await runWithSupervisorLock(socketPath, stateDirectory, createBindings(stateDirectory));
        } finally {
          lock.release();
          logger.info("Coordinator process stopped", { event: "coordinator:stopped" });
        }
      },
    );
  } finally {
    await dispose();
  }
}

/**
 * Takes the Coordinator's lifetime lock, or, when another CoForge Daemon already holds it,
 * raises a message that names the holder and how to clear it instead of letting bun:sqlite's
 * raw "database is locked" reach the person running `foreground`. Exported as its own function
 * so a test can drive real lock contention (two in-process `acquireProcessLock` calls on the
 * same path) without spawning a second process.
 */
export async function acquireSupervisorLock(stateDirectory: string): Promise<ProcessLock> {
  const lockPath = join(stateDirectory, "supervisor-lock.sqlite");
  try {
    return acquireProcessLock(lockPath);
  } catch (error) {
    if (!isLockContention(error)) throw error;
    // Keeps SQLite's own code on the cause, so the technical reason survives for anyone reading
    // a stack trace while the message stays the one a person can act on.
    throw new Error(await describeSupervisorLockHeld(stateDirectory, lockPath), { cause: error });
  }
}

async function describeSupervisorLockHeld(
  stateDirectory: string,
  lockPath: string,
): Promise<string> {
  const ownerPid = await readSupervisorLockOwnerPid(stateDirectory);
  const holder = ownerPid !== null ? ` (pid ${ownerPid})` : "";
  return [
    `Another CoForge Daemon is already running on this Computer${holder} and holds the supervisor lock at ${lockPath}.`,
    "Run `coforge-computer status` to see it, then `coforge-computer stop` before running `foreground` again.",
  ].join("\n");
}

/** Best-effort: the owner file is written by the process that currently holds the lock
 * (`runWithSupervisorLock`, below), so a missing or unreadable file means only that the pid
 * cannot be shown, never that the lock itself is free — the caller already knows it is held. */
async function readSupervisorLockOwnerPid(stateDirectory: string): Promise<number | null> {
  try {
    const text = (await readFile(join(stateDirectory, "supervisor.lock", "owner"), "utf8")).trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function runWithSupervisorLock(
  socketPath: string,
  stateDirectory: string,
  bindings: BindingStore,
): Promise<void> {
  const lockMarker = join(stateDirectory, "supervisor.lock");
  await mkdir(lockMarker, { recursive: true, mode: 0o700 });
  await writeFile(join(lockMarker, "owner"), String(process.pid), { mode: 0o600 });
  const holdPath = join(stateDirectory, "launch-hold");
  const workspaceDirectory = (id: string) => workspaceStateDirectory(stateDirectory, id);
  const children = new Map<
    string,
    { instance: WorkspaceInstance; identity: ManagedRuntimeIdentity; osInstanceId: string }
  >();
  const childClient = (workspaceId: string) =>
    new LocalDaemonLauncher({
      executablePath: process.execPath,
      socketPath: join(workspaceDirectory(workspaceId), "daemon.sock"),
      spawn: () => {},
    });
  const workspaceInstance = (workspaceId: string): WorkspaceInstance => {
    const config = {
      stateRoot: stateDirectory,
      workspaceId,
      executablePath: process.execPath,
      socketPath: join(workspaceDirectory(workspaceId), "daemon.sock"),
      stateDirectory: workspaceDirectory(workspaceId),
      unitDirectory:
        process.platform === "darwin"
          ? join(stateDirectory, "launchd-workspaces")
          : join(homedir(), ".config", "systemd", "user"),
      supervisorSocketPath: socketPath,
      daemonConnectionEndpoint: Bun.env.COFORGE_DAEMON_CONNECTION_ENDPOINT,
    };
    if (process.platform === "darwin") return new LaunchdWorkspaceInstance(config);
    if (process.platform !== "linux")
      throw new Error("per-Workspace OS containment is not implemented on this platform");
    return new SystemdWorkspaceInstance(config, async (args) => {
      const command = Bun.spawn(["systemctl", "--user", ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return await command.exited;
    });
  };
  const upgradeLogger = getLogger(["coforge", "daemon", "supervisor"]);
  /**
   * Asks one Workspace daemon to hold (or release) its runners. A Workspace that does not answer
   * inside `RUNNER_HOLD_WORKSPACE_TIMEOUT_MS`, answers `accepted: false`, or fails outright is
   * reported unreachable and counted as idle: a wedged or dead Workspace daemon must never be
   * able to block a Computer upgrade (ADR 0020) or a restart (ADR 0021). Shared by the
   * Coordinator-wide fan-out below and by the per-Workspace restart hold.
   */
  const holdWorkspaceRunners = async (
    workspaceId: string,
    operation: "hold" | "release",
    reason: string,
    eventPrefix: string,
    // `unreachableWorkspaceIds` is optional on the wire report but always known here, so the
    // restart hold can read it without a fallback.
  ): Promise<DaemonHoldReport & { unreachableWorkspaceIds: string[] }> => {
    const held = operation === "hold";
    try {
      const response = await answeredWithin(
        childClient(workspaceId).hold(operation, reason),
        RUNNER_HOLD_WORKSPACE_TIMEOUT_MS,
        `Workspace ${workspaceId} did not answer the runner hold`,
      );
      if (!response.accepted)
        return { held, busyAgents: [], unreachableWorkspaceIds: [workspaceId] };
      return {
        held,
        busyAgents: response.busyAgents.map((agent) => ({
          ...agent,
          workspaceId: agent.workspaceId || workspaceId,
        })),
        unreachableWorkspaceIds: [],
      };
    } catch (error) {
      upgradeLogger.warn("Workspace daemon did not answer the runner hold; treating as idle", {
        event: `${eventPrefix}:runner_hold_unreachable`,
        workspace_id: workspaceId,
        operation,
        timeout_ms: RUNNER_HOLD_WORKSPACE_TIMEOUT_MS,
        error_message: error instanceof Error ? error.message : String(error),
      });
      return { held, busyAgents: [], unreachableWorkspaceIds: [workspaceId] };
    }
  };
  /**
   * Read-only settle check for `MachineSupervisor.recordUpgrade`'s blocking pending operation: a
   * receipt already on disk, or the pending TTL already passed, settles it right there instead of
   * refusing the new request. Captures the answer through `sweepComputerUpgradeReceipts`'
   * `complete` callback rather than calling back into the supervisor - this runs inside
   * `recordUpgrade`'s own serialized mutation, which a call to `supervisor.completeUpgrade` would
   * deadlock against.
   */
  const settlePendingUpgrade = async (
    workspaceId: string,
    requestId: string,
    requestedAt: number,
  ) => {
    let settlement: ComputerUpgradeReceipt | undefined;
    await sweepComputerUpgradeReceipts(
      [{ workspaceId, requestId, requestedAt }],
      async (_workspaceId, _requestId, receipt) => {
        settlement = receipt;
      },
      { pendingTtlMs: UPGRADE_OPERATION_PENDING_TTL_MS },
    );
    return settlement;
  };
  /**
   * The config a Workspace daemon child reads: pending operations are ready hints; terminal ones
   * are results it owes the server. Under normal promotion `daemon:resume` settles the receipt
   * before `start(binding)` writes this config and spawns the child, so its first ready can report
   * immediately. `refreshChildUpgradeConfig` remains the reconnect/crash-recovery fallback.
   */
  const buildChildConfig = (binding: ManagedBinding) => {
    // Only the replacement receives the pending request as a cloud ready hint.
    // Local completion still requires the application handshake and durable result.
    const restartRequestIds = (binding.restartResults ?? [])
      .filter((result) => result.status === "completed")
      .map((result) => result.requestId);
    if (binding.restart?.phase === "starting") restartRequestIds.push(binding.restart.requestId);
    const {
      enabled: _enabled,
      restart: _restart,
      restartResults: _results,
      restartRequestIds: _legacy,
      upgradeRequestIds: _upgrades,
      upgradeRequests: _legacyUpgrades,
      upgradeOperations,
      ...config
    } = binding;
    const operations = (upgradeOperations ?? [])
      .filter((operation) => operation.state !== "acknowledged")
      .slice(-128);
    return {
      ...config,
      restartRequestIds: restartRequestIds.slice(-128),
      upgradeRequestIds: operations.map((entry) => entry.requestId),
      upgradeExpectedVersions: Object.fromEntries(
        operations.map((entry) => [entry.requestId, entry.expectedVersion]),
      ),
      upgradeOperations: operations,
    };
  };
  /** Rewrites one already-running Workspace's config file with its binding's current upgrade
   * state, without restarting it. Best-effort: a Workspace that was never started (no directory
   * yet) or whose write fails is left for its next real start to pick up instead. */
  const refreshChildUpgradeConfig = async (workspaceId: string): Promise<void> => {
    try {
      const binding = (await supervisor.snapshot()).find(
        (entry) => entry.workspaceId === workspaceId,
      );
      if (!binding) return;
      await new DaemonConfigStore(workspaceDirectory(workspaceId)).save(buildChildConfig(binding));
    } catch (error) {
      upgradeLogger.warn("Refreshing a Workspace's local upgrade config failed", {
        event: "upgrade:child_config_refresh_failed",
        workspace_id: workspaceId,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // Stable OS units own processes even if the Coordinator died before readiness.
  // Recovery adopts them through MainPID + the daemon handshake, never by killing PIDs.
  const supervisor = new MachineSupervisor(
    bindings,
    {
      async start(binding) {
        const directory = workspaceDirectory(binding.workspaceId);
        await new DaemonConfigStore(directory).save(buildChildConfig(binding));
        const instance = workspaceInstance(binding.workspaceId);
        const processId = await instance.ensureStarted();
        const observed = await instance.identity();
        if (!observed?.active || observed.mainPid !== processId)
          throw new Error("Workspace OS identity changed during startup");
        const identity = {
          workspaceId: binding.workspaceId,
          computerId: binding.computerId,
          enabled: true,
          processId,
          instanceId: "",
          version: "",
        };
        children.set(binding.workspaceId, {
          instance,
          identity,
          osInstanceId: observed.invocationId,
        });
        const client = childClient(binding.workspaceId);
        const deadline = Date.now() + 30_000;
        try {
          while (Date.now() < deadline) {
            const reported = await client.identity().catch(() => null);
            if (reported?.processId === processId && reported.version === COFORGE_DAEMON_VERSION) {
              const current = await instance.identity();
              if (!current?.active || current.invocationId !== observed.invocationId)
                throw new Error("Workspace OS identity changed during handshake");
              identity.instanceId = reported.daemonId;
              identity.version = reported.version;
              return observed.invocationId;
            }
            await Bun.sleep(50);
          }
          throw new Error(`Workspace ${binding.workspaceId} failed process readiness`);
        } catch (error) {
          // A failed handshake is not permission to kill an adopted live unit.
          children.delete(binding.workspaceId);
          throw error;
        }
      },
      async stop(binding) {
        const child = children.get(binding.workspaceId);
        // Includes recovery after enabled=false was persisted but OS stop was interrupted.
        // systemd sends SIGTERM to the Workspace main, then kills residual cgroup members.
        await (child?.instance ?? workspaceInstance(binding.workspaceId)).stop();
        children.delete(binding.workspaceId);
      },
      async instance(binding) {
        const observed = await workspaceInstance(binding.workspaceId).identity();
        return observed && observed.mainPid > 0 ? observed.invocationId : null;
      },
      // Per-Workspace, so a restart never reaches past its own target: an unscoped restart holds
      // each enabled binding in turn as the loop gets to it, not the whole machine at once. The
      // Coordinator-wide fan-out below stays the upgrade's path (ADR 0021).
      hold: (binding, reason) =>
        holdWorkspaceRunners(binding.workspaceId, "hold", reason, "restart"),
      release: (binding, reason) =>
        holdWorkspaceRunners(binding.workspaceId, "release", reason, "restart"),
      clearHealth: (binding) =>
        new WorkspaceHealthJournal(
          workspaceHealthJournalPath(workspaceDirectory(binding.workspaceId)),
        ).clear(),
    },
    Date.now,
    {},
    settlePendingUpgrade,
  );
  // Assigned after reading launch-hold, before startup sweep or local RPC can settle/resume.
  let heldRecovery: HeldUpgradeRecovery | undefined;
  const scopedCredentials = (workspaceId: string) =>
    new FileDaemonCredentialStore(workspaceDirectory(workspaceId));
  const snapshot = async () =>
    (await supervisor.snapshot()).map((binding) => {
      const child = children.get(binding.workspaceId);
      return child && binding.instanceId === child.osInstanceId
        ? { ...child.identity, enabled: binding.enabled }
        : {
            workspaceId: binding.workspaceId,
            computerId: binding.computerId,
            enabled: binding.enabled,
            processId: 0,
            instanceId: "",
            version: "",
          };
    });
  const completeUpgrade = async (
    workspaceId: string,
    requestId: string,
    receipt: ComputerUpgradeReceipt,
  ) => {
    const recorded = await supervisor.completeUpgrade(workspaceId, requestId, {
      status: receipt.status,
      at: receipt.at,
      ...(receipt.version ? { version: receipt.version } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
    });
    if (recorded) {
      upgradeLogger.info("Computer upgrade operation reached its terminal state", {
        event: "upgrade:operation_settled",
        request_id: requestId,
        workspace_id: workspaceId,
        status: receipt.status,
      });
      // Under launch-hold the replacement Workspace has not started yet; refresh its config now
      // so the first ready/report pass sees terminal state. Outside an upgrade this remains safe
      // for an already-running child and its next reconnect recovery.
      await refreshChildUpgradeConfig(workspaceId);
      if (shouldAutoFinishHeldUpgrade(heldRecovery, requestId, receipt))
        await heldRecovery!.finish(requestId, true);
    }
    return recorded;
  };
  const pendingUpgradeOperations = async (requestId?: string) =>
    (await supervisor.snapshot()).flatMap((binding) =>
      (binding.upgradeOperations ?? [])
        .filter(
          (operation) =>
            operation.state === "pending" && (!requestId || operation.requestId === requestId),
        )
        .map((operation) => ({
          workspaceId: binding.workspaceId,
          requestId: operation.requestId,
          requestedAt: operation.requestedAt,
        })),
    );
  const upgradeOperation = async (requestId: string) =>
    (await supervisor.snapshot())
      .flatMap((binding) => binding.upgradeOperations ?? [])
      .find((operation) => operation.requestId === requestId);
  const settlePendingUpgradeOperations = async (requireTerminal = false, requestId?: string) => {
    try {
      // A stranded operation is aged out here too: without that, one lost receipt would refuse
      // every later upgrade on this machine.
      await sweepComputerUpgradeReceipts(
        await pendingUpgradeOperations(requestId),
        completeUpgrade,
        { pendingTtlMs: UPGRADE_OPERATION_PENDING_TTL_MS },
      );
      if (requireTerminal) {
        if (!requestId) throw new Error("Computer upgrade resume requires a request ID");
        const operation = await upgradeOperation(requestId);
        if (!operation || operation.state === "pending")
          throw new Error(`Computer upgrade receipt is not terminal: ${requestId}`);
        if (!operationAllowsWorkspaceRecovery(operation))
          throw new Error(`Computer upgrade receipt cannot release launch-hold: ${requestId}`);
      }
    } catch (error) {
      upgradeLogger.error("Computer upgrade receipt sweep failed", {
        event: "upgrade:receipt_sweep_failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      if (requireTerminal) throw error;
    }
  };
  /**
   * Keeps watching one pending operation - either one this process launched, or crash-recovery
   * state whose receipt was not yet available. The normal promoted path is stricter: the external
   * job writes its receipt, then `daemon:resume` performs a synchronous settle before Workspace
   * launch. This watch remains the fallback when either side dies between those steps and shares
   * the same TTL as startup sweeping. Cancelled at shutdown through `upgradeWatchController`.
   */
  const upgradeWatchController = new AbortController();
  const upgradeWatches = new Set<Promise<void>>();
  const watchPendingUpgrade = (workspaceId: string, requestId: string, requestedAt: number) => {
    const watch = watchComputerUpgradeReceipt(
      { workspaceId, requestId, requestedAt },
      completeUpgrade,
      {
        signal: upgradeWatchController.signal,
        pollMs: UPGRADE_RECEIPT_POLL_MS,
        ttlMs: UPGRADE_OPERATION_PENDING_TTL_MS,
      },
    ).catch((error) =>
      upgradeLogger.error("Computer upgrade receipt watch failed", {
        event: "upgrade:receipt_watch_failed",
        workspace_id: workspaceId,
        request_id: requestId,
        error_message: error instanceof Error ? error.message : String(error),
      }),
    );
    upgradeWatches.add(watch);
    void watch.finally(() => upgradeWatches.delete(watch));
  };
  /**
   * Fans a runner hold (or release) out to every running Workspace daemon under this Coordinator
   * and merges their answers. This is the only Coordinator->Workspace call in the codebase; it
   * reuses the per-Workspace `childClient` sockets the Coordinator already owns.
   */
  const fanOutRunnerHold = async (
    operation: "hold" | "release",
    reason: string,
  ): Promise<DaemonHoldReport> => {
    const running = (await snapshot()).filter((runtime) => runtime.processId > 0);
    const reports = await Promise.all(
      running.map(({ workspaceId }) =>
        holdWorkspaceRunners(workspaceId, operation, reason, "upgrade"),
      ),
    );
    return {
      held: operation === "hold",
      busyAgents: reports.flatMap((report) => report.busyAgents),
      unreachableWorkspaceIds: reports.flatMap((report) => report.unreachableWorkspaceIds),
    };
  };
  let rpc: Awaited<ReturnType<typeof startDaemonLocalRpcServer>> | undefined;
  // A replacement Coordinator starts while the external upgrade job still owns launch-hold.
  // Load durable bindings and expose local RPC, but do not start any Workspace until the job has
  // committed its terminal receipt and explicitly resumes this process.
  const holdFile = Bun.file(holdPath);
  const heldAtStartup = await holdFile.exists();
  const persistedHoldRequestId = heldAtStartup ? (await holdFile.text()).trim() : undefined;
  try {
    try {
      await supervisor.recover({ paused: heldAtStartup });
    } catch (error) {
      if (!(error instanceof WorkspaceRecoveryError)) throw error;
      // Keep local control available for explicit stop/retry; other Workspaces were reconciled.
      getLogger(["coforge", "daemon", "supervisor"]).error(
        "Workspace recovery incomplete: {error}",
        { error },
      );
    }
    const upgradeOperations = (await supervisor.snapshot()).flatMap(
      (binding) => binding.upgradeOperations ?? [],
    );
    const heldRequestId = resolveHeldRequestId(persistedHoldRequestId, upgradeOperations);
    heldRecovery = new HeldUpgradeRecovery(heldAtStartup, heldRequestId, {
      settle: (requestId) => settlePendingUpgradeOperations(true, requestId),
      resume: () => supervisor.resume(),
      clearHold: () => rm(holdPath, { force: true }),
      isWorkspaceRecoveryError: (error) => error instanceof WorkspaceRecoveryError,
      onWorkspaceRecoveryError: (error) =>
        upgradeLogger.error("Workspace recovery after Computer promotion was incomplete", {
          event: "upgrade:workspace_recovery_incomplete",
          error_message: error.message,
        }),
    });
    const heldOperation = upgradeOperations.find(
      (operation) => operation.requestId === heldRequestId,
    );
    if (heldRecovery.active && heldOperation && operationAllowsWorkspaceRecovery(heldOperation))
      await heldRecovery.finish(heldOperation.requestId, true);
    // Best-effort crash recovery: an old receipt may already exist when this Coordinator starts.
    // During the normal held replacement path the receipt intentionally arrives later and the
    // strict `daemon:resume` branch settles it synchronously before any Workspace starts.
    await settlePendingUpgradeOperations();
    // Anything still pending is watched as a fallback for a job/Coordinator interrupted before
    // the normal resume handshake.
    for (const operation of await pendingUpgradeOperations())
      watchPendingUpgrade(operation.workspaceId, operation.requestId, operation.requestedAt);
    rpc = await startDaemonLocalRpcServer({
      socketPath,
      version: COFORGE_DAEMON_VERSION,
      validateCredential: async (value) => value.length > 0 && !(await Bun.file(holdPath).exists()),
      credentials: {
        load: (w, c) => scopedCredentials(w).load(w, c),
        save: (w, c, key) => scopedCredentials(w).save(w, c, key),
        delete: (w, c) => scopedCredentials(w).delete(w, c),
      },
      runtime: {
        configure: (config) => supervisor.configure(config),
        hold: (reason) => fanOutRunnerHold("hold", reason),
        release: () => fanOutRunnerHold("release", "upgrade"),
        async command(method, request) {
          if (method === "daemon:pause") await supervisor.pause();
          else if (method === "daemon:resume") {
            if (heldRecovery?.active) await heldRecovery.finish(request.requestId);
            else await supervisor.resume();
          } else if (method === "daemon:upgrade") {
            if (!request.workspaceId || !request.expectedVersion)
              throw new Error("upgrade requires workspace and expected version");
            const created = await supervisor.recordUpgrade(
              request.workspaceId,
              request.requestId,
              request.expectedVersion,
            );
            if (created) {
              // Pushes down any settlement `recordUpgrade` just applied to the pending operation
              // it replaced, in addition to the new one, without restarting this Workspace.
              await refreshChildUpgradeConfig(request.workspaceId);
              try {
                await launchComputerUpgrade(request.requestId, request.expectedVersion, {
                  stateDirectory,
                });
              } catch (error) {
                // `recordUpgrade` already committed a "pending" operation for this request; a
                // job that never started must not leave it sitting there for the full pending
                // TTL, refusing every later upgrade in the meantime (the requirement this
                // record exists for: never leave an operation pending when the launch itself is
                // what failed).
                const message = error instanceof Error ? error.message : String(error);
                await completeUpgrade(request.workspaceId, request.requestId, {
                  requestId: request.requestId,
                  status: "failed",
                  at: Date.now(),
                  error: message,
                  errorCode: UPGRADE_ERROR_CODE.LAUNCH_FAILED,
                });
                throw new UpgradeLaunchFailedError(message, { cause: error });
              }
              watchPendingUpgrade(request.workspaceId, request.requestId, Date.now());
            }
          } else if (method === "daemon:upgrade_ack") {
            if (!request.workspaceId) throw new Error("upgrade acknowledgement requires workspace");
            if (await supervisor.acknowledgeUpgrade(request.workspaceId, request.requestId))
              // Drops the now-acknowledged operation from the child's local config too, or a
              // later reconnect would keep re-reporting the same already-acknowledged result.
              await refreshChildUpgradeConfig(request.workspaceId);
          } else if (method !== "daemon:snapshot") {
            const operation = method.slice("daemon:".length);
            if (operation !== "start" && operation !== "stop" && operation !== "restart")
              throw new Error("unknown lifecycle operation");
            await supervisor.command(
              operation,
              request.workspaceId,
              operation === "restart" ? request.requestId : undefined,
            );
          }
          return snapshot();
        },
      },
    });
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => resolve());
      process.once("SIGINT", () => resolve());
    });
  } finally {
    // Every upgrade receipt watch is Coordinator-owned and must not outlive this process: an
    // uncancelled one is exactly the pending `Bun.sleep` that kept the Coordinator alive past its
    // own shutdown (ADR 0032/0037). Aborting resolves each watch's current sleep immediately, so
    // awaiting them here costs no meaningful time.
    upgradeWatchController.abort();
    await Promise.allSettled(upgradeWatches);
    let cleaned = false;
    try {
      // Startup/adoption failure must not tear down other already-running units.
      if (rpc) await supervisor.shutdown();
      cleaned = true;
    } finally {
      await rpc?.close();
      if (cleaned) await rm(join(lockMarker, "owner"), { force: true });
    }
  }
}
