import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import {
  holdRunnersUntilQuiescent,
  LocalDaemonLauncher,
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
  workspaceStateDirectory,
  type RunnerHoldOutcome,
} from "@lrm/coforge-daemon";

const logger = getLogger(["coforge", "computer", "upgrade"]);

export type CoordinatorBinding = {
  bindingId: string;
  enabled: boolean;
  running: boolean;
  processId: number | null;
};

/** What the Computer's Coordinator is running, and every reason its Workspace runtime set is not
 * in the state its bindings ask for. An upgrade refuses to start unless `problems` is empty. */
export type CoordinatorStatus = {
  supervisor: { running: false } | { running: true; id?: string; version?: string };
  bindings: CoordinatorBinding[];
  problems: string[];
};

export type CoordinatorControlOptions = {
  supervisorSocketPath: string;
  supervisorStatePath: string;
  /** How long `pause` waits for Workspace lifecycle work already running; tests shorten it. */
  lifecycleSettle?: { timeoutMs: number; pollMs: number };
};

/**
 * How long a pause waits for the Workspace lifecycle work already running to finish: one
 * restart's runner hold (30 s), its stop, and its readiness (30 s), with room to spare. Work still
 * queued is refused by the pause, so only running work is waited for.
 */
const LIFECYCLE_SETTLE = { timeoutMs: 120_000, pollMs: 500 };

/** The Coordinator is not answering on its local socket. */
export class CoordinatorNotRunningError extends Error {
  constructor(options?: ErrorOptions) {
    super("The Computer supervisor is not running.", options);
    this.name = "CoordinatorNotRunningError";
  }
}

/**
 * The operations an upgrade performs on a running Computer's Coordinator, over its local RPC
 * socket: read its state, pause and resume Workspace launches, and hold and release Agent runners.
 * Shared by the product's own upgrade coordinator and `__lifecycle`, through which the installer
 * drives the same steps. The `launch-hold` file is not written or removed here: whoever runs the
 * upgrade transaction owns it.
 */
export function createCoordinatorControl(options: CoordinatorControlOptions) {
  const local = new LocalDaemonLauncher({
    // Never spawned: `spawn` is a no-op, so the path only has to name this executable.
    executablePath: process.execPath,
    socketPath: options.supervisorSocketPath,
    stateDirectory: options.supervisorStatePath,
    spawn: () => {},
  });

  /** The running Coordinator's process identity and build version. */
  async function identity(): Promise<{ id?: string; version?: string }> {
    try {
      const { daemonId, version } = await local.identity();
      return { ...(daemonId ? { id: daemonId } : {}), ...(version ? { version } : {}) };
    } catch (error) {
      throw new CoordinatorNotRunningError({ cause: error });
    }
  }

  /** The bindings the Coordinator persisted, read while it is not running. A parked Workspace is
   * down on purpose (the cloud refused it for good), so only an enabled one that is not parked
   * counts as a problem. */
  async function persistedStatus(): Promise<CoordinatorStatus> {
    const file = Bun.file(join(options.supervisorStatePath, "bindings.json"));
    const persisted = (await file.exists())
      ? ((await file.json()) as { workspaceId: string; enabled: boolean }[])
      : [];
    let unparkedEnabled = false;
    for (const binding of persisted) {
      if (!binding.enabled) continue;
      const health = await new WorkspaceHealthJournal(
        workspaceHealthJournalPath(
          workspaceStateDirectory(options.supervisorStatePath, binding.workspaceId),
        ),
      ).state();
      if (health.status !== "parked") unparkedEnabled = true;
    }
    return {
      supervisor: { running: false },
      bindings: persisted.map((binding) => ({
        bindingId: binding.workspaceId,
        enabled: binding.enabled,
        running: false,
        processId: null,
      })),
      problems: unparkedEnabled
        ? [
            "configured running bindings have no healthy supervisor. Run 'coforge-computer start' to recover them, then upgrade again.",
          ]
        : [],
    };
  }

  /** The running Coordinator's own snapshot. A parked Workspace is enabled but down on purpose;
   * it neither counts as a problem nor gets started again by an upgrade. */
  async function runningStatus(): Promise<CoordinatorStatus> {
    const supervisor = await identity();
    const runtimes = await local.control("snapshot");
    return {
      supervisor: { running: true, ...supervisor },
      bindings: runtimes.map((runtime) => ({
        bindingId: runtime.workspaceId,
        enabled: runtime.enabled,
        running: runtime.processId > 0,
        processId: runtime.processId || null,
      })),
      problems: runtimes.flatMap((runtime) => {
        const id = runtime.workspaceId;
        if (runtime.processId > 0 && !runtime.enabled)
          return [
            `Workspace ${id} is stopped but still running. Run 'coforge-computer stop --workspace ${id}', then upgrade again.`,
          ];
        if (runtime.processId === 0 && runtime.enabled && runtime.parkReason === undefined)
          return [
            `Workspace ${id} is enabled but not running. Run 'coforge-computer start --workspace ${id}' (or 'coforge-computer stop --workspace ${id}' to leave it stopped), then upgrade again.`,
          ];
        return [];
      }),
    };
  }

  return {
    identity,
    persistedStatus,
    runningStatus,

    async isRunning(): Promise<boolean> {
      return identity().then(
        () => true,
        () => false,
      );
    },

    async status(): Promise<CoordinatorStatus> {
      return (await this.isRunning()) ? runningStatus() : persistedStatus();
    },

    /** Stops new Workspace lifecycle work at once, then waits, bounded, for the work already
     * running to finish. If it does not, launches are resumed and the pause fails. */
    async pause(requestId: string): Promise<void> {
      await identity();
      await local.control("pause", undefined, requestId);
      try {
        await settleLifecycleWork(local, options.lifecycleSettle ?? LIFECYCLE_SETTLE);
      } catch (error) {
        await this.resume(requestId).catch(() => {});
        throw error;
      }
    },

    /** Stops every Agent admitting new turns and waits, bounded, for in-flight work to finish. */
    async hold(): Promise<RunnerHoldOutcome> {
      await identity();
      const outcome = await holdRunnersUntilQuiescent({
        hold: async () => {
          const response = await local.hold("hold");
          if (!response.accepted) throw new Error("Coordinator did not accept the runner hold");
          return response;
        },
        // The wait itself lives in the daemon package, shared with the Coordinator's restart hold.
        // Keep this path's own logger and `upgrade:` event names.
        logger,
        eventPrefix: "upgrade",
      });
      logger.info("Runner hold completed", {
        event: outcome.quiescent ? "upgrade:runner_hold_quiescent" : "upgrade:runner_hold_expired",
        operation: "hold",
        quiescent: outcome.quiescent,
        elapsed_ms: outcome.elapsedMs,
        busy_agent_count: outcome.busyAgents.length,
        unreachable_workspace_ids: outcome.unreachableWorkspaceIds,
      });
      return outcome;
    },

    /** Lifts the runner hold. Idempotent. */
    async release(): Promise<void> {
      await identity();
      await local.hold("release");
    },

    /** Lifts the runner hold, then lets Workspace launches proceed. Releasing first is what lifts
     * a hold on an upgrade aborted before the stop; on the success path the Coordinator answering
     * is a fresh process that was never held, and the release is a no-op. */
    async resume(requestId: string): Promise<void> {
      await identity();
      await local.hold("release").catch(() => {});
      await local.control("resume", undefined, requestId);
    },
  };
}

export type CoordinatorControl = ReturnType<typeof createCoordinatorControl>;

/**
 * Waits until no Workspace start, restart, or configure is under way (`lifecycleUnderWay` in the
 * Coordinator's snapshot), or gives up naming them.
 */
async function settleLifecycleWork(
  local: LocalDaemonLauncher,
  settle: { timeoutMs: number; pollMs: number },
): Promise<void> {
  const deadline = Date.now() + settle.timeoutMs;
  while (true) {
    const runtimes = await local.control("snapshot").catch(() => []);
    const underWay = runtimes.filter((runtime) => runtime.lifecycleUnderWay);
    if (!underWay.length) return;
    if (Date.now() >= deadline) {
      const ids = underWay.map((runtime) => runtime.workspaceId);
      throw new Error(
        `Workspace ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} still starting or restarting. Run 'coforge-computer status' to follow ${ids.length === 1 ? "it" : "them"}, then upgrade again.`,
      );
    }
    await Bun.sleep(settle.pollMs);
  }
}
