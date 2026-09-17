import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { startDaemonLocalRpcServer, type DaemonHoldReport } from "../local-rpc";
import { FileDaemonCredentialStore } from "../credentials/credential-store";
import { DaemonConfigStore } from "../persistence/daemon-config";
import { LocalDaemonLauncher } from "../daemon-host/launcher";
import { acquireProcessLock } from "../platform/process-lock";
import {
  MachineSupervisor,
  UPGRADE_OPERATION_PENDING_TTL_MS,
  WorkspaceRecoveryError,
  type BindingStore,
} from "./machine-supervisor";
import { FileBindingStore } from "./binding-store";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { configureDaemonLogging } from "../platform/daemon-logging";
import { COFORGE_DAEMON_VERSION } from "../version";
import { SystemdWorkspaceInstance } from "./systemd-workspace-instance";
import { LaunchdWorkspaceInstance } from "./launchd-workspace-instance";
import type { WorkspaceInstance } from "./workspace-instance";
import { answeredWithin } from "./runner-hold";
import { COFORGE_DAEMON_SERVER_URL } from "../connection/built-server";
import { launchComputerUpgrade } from "../platform/computer-upgrade-launcher";
import { sweepLeftoverComputerUpgradeJobs } from "../platform/computer-upgrade-sweep";
import {
  sweepComputerUpgradeReceipts,
  type ComputerUpgradeReceipt,
} from "../platform/computer-upgrade-receipts";

/** How long, and how often, a Coordinator watches for a receipt from a job it launched. */
const UPGRADE_RECEIPT_WATCH_MS = 10 * 60_000;
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
        const lock = acquireProcessLock(join(stateDirectory, "supervisor-lock.sqlite"));
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

async function runWithSupervisorLock(
  socketPath: string,
  stateDirectory: string,
  bindings: BindingStore,
): Promise<void> {
  const lockMarker = join(stateDirectory, "supervisor.lock");
  await mkdir(lockMarker, { recursive: true, mode: 0o700 });
  await writeFile(join(lockMarker, "owner"), String(process.pid), { mode: 0o600 });
  const holdPath = join(stateDirectory, "launch-hold");
  const workspaceDirectory = (id: string) =>
    join(stateDirectory, "workspaces", Buffer.from(id).toString("base64url"));
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
  // Stable OS units own processes even if the Coordinator died before readiness.
  // Recovery adopts them through MainPID + the daemon handshake, never by killing PIDs.
  const supervisor = new MachineSupervisor(bindings, {
    async start(binding) {
      const directory = workspaceDirectory(binding.workspaceId);
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
      // The replacement carries every operation it must still settle with the server: pending
      // ones as cloud ready hints, terminal ones as results it owes the server a report for.
      const operations = (upgradeOperations ?? [])
        .filter((operation) => operation.state !== "acknowledged")
        .slice(-128);
      const childConfig = {
        ...config,
        restartRequestIds: restartRequestIds.slice(-128),
        upgradeRequestIds: operations.map((entry) => entry.requestId),
        upgradeExpectedVersions: Object.fromEntries(
          operations.map((entry) => [entry.requestId, entry.expectedVersion]),
        ),
        upgradeOperations: operations,
      };
      await new DaemonConfigStore(directory).save(childConfig);
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
    hold: (binding, reason) => holdWorkspaceRunners(binding.workspaceId, "hold", reason, "restart"),
    release: (binding, reason) =>
      holdWorkspaceRunners(binding.workspaceId, "release", reason, "restart"),
  });
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
    });
    if (recorded)
      upgradeLogger.info("Computer upgrade operation reached its terminal state", {
        event: "upgrade:operation_settled",
        request_id: requestId,
        workspace_id: workspaceId,
        status: receipt.status,
      });
    return recorded;
  };
  const pendingUpgradeOperations = async () =>
    (await supervisor.snapshot()).flatMap((binding) =>
      (binding.upgradeOperations ?? [])
        .filter((operation) => operation.state === "pending")
        .map((operation) => ({
          workspaceId: binding.workspaceId,
          requestId: operation.requestId,
          requestedAt: operation.requestedAt,
        })),
    );
  const settlePendingUpgradeOperations = async () => {
    try {
      // A stranded operation is aged out here too: without that, one lost receipt would refuse
      // every later upgrade on this machine.
      await sweepComputerUpgradeReceipts(await pendingUpgradeOperations(), completeUpgrade, {
        pendingTtlMs: UPGRADE_OPERATION_PENDING_TTL_MS,
      });
    } catch (error) {
      upgradeLogger.error("Computer upgrade receipt sweep failed", {
        event: "upgrade:receipt_sweep_failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  /** Best-effort in-process watch; the startup sweep above is the durable backstop. */
  const watchUpgradeReceipt = (workspaceId: string, requestId: string, requestedAt: number) => {
    void (async () => {
      const deadline = Date.now() + UPGRADE_RECEIPT_WATCH_MS;
      while (Date.now() < deadline) {
        await Bun.sleep(UPGRADE_RECEIPT_POLL_MS);
        // The watch only waits for a receipt; ageing a stranded operation out belongs to the
        // startup sweep, which is the one that still runs after this process is replaced.
        const settled = await sweepComputerUpgradeReceipts(
          [{ workspaceId, requestId, requestedAt }],
          completeUpgrade,
        ).catch(() => 0);
        if (settled) return;
      }
    })();
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
  try {
    try {
      await supervisor.recover();
    } catch (error) {
      if (!(error instanceof WorkspaceRecoveryError)) throw error;
      // Keep local control available for explicit stop/retry; other Workspaces were reconciled.
      getLogger(["coforge", "daemon", "supervisor"]).error(
        "Workspace recovery incomplete: {error}",
        { error },
      );
    }
    // A remote upgrade stops and replaces this very process, so Coordinator startup is the first
    // moment anything can observe what the job the old process launched actually did.
    await settlePendingUpgradeOperations();
    if (await Bun.file(holdPath).exists()) await supervisor.pause();
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
          else if (method === "daemon:resume") await supervisor.resume();
          else if (method === "daemon:upgrade") {
            if (!request.workspaceId || !request.expectedVersion)
              throw new Error("upgrade requires workspace and expected version");
            const created = await supervisor.recordUpgrade(
              request.workspaceId,
              request.requestId,
              request.expectedVersion,
            );
            if (created) {
              await launchComputerUpgrade(request.requestId, request.expectedVersion, {
                stateDirectory,
              });
              watchUpgradeReceipt(request.workspaceId, request.requestId, Date.now());
            }
          } else if (method === "daemon:upgrade_ack") {
            if (!request.workspaceId) throw new Error("upgrade acknowledgement requires workspace");
            await supervisor.acknowledgeUpgrade(request.workspaceId, request.requestId);
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
