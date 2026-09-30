import { homedir } from "node:os";
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

import { resolveComputerStateDirectory, resolveDaemonSocketPath } from "#src/paths";

const logger = getLogger(["coforge", "computer", "upgrade"]);

export type SupervisorBinding = {
  bindingId: string;
  enabled: boolean;
  running: boolean;
  processId: number | null;
};

/** One reason the runtime set is not healthy: `code` is one of `SUPERVISOR_PROBLEM_CODE`,
 * `message` a sentence for a person naming the command that fixes it, and `bindingId` is set when
 * the problem is one Workspace's. */
export type SupervisorProblem = { code: string; bindingId?: string; message: string };

/** What the Computer supervisor is running, and every reason its Workspace runtime set is not in
 * the state its bindings ask for. An upgrade refuses to start unless `problems` is empty. */
export type SupervisorStatus = {
  supervisor: { running: false } | { running: true; id?: string; version?: string };
  bindings: SupervisorBinding[];
  problems: SupervisorProblem[];
};

/** Why a runtime set is not healthy (`SupervisorProblem.code`; installer/contract/lifecycle-codes.json). */
export const SUPERVISOR_PROBLEM_CODE = {
  /** Enabled Workspaces that are not parked, and no supervisor running them. */
  SUPERVISOR_NOT_RUNNING: "LIFECYCLE_SUPERVISOR_NOT_RUNNING",
  /** An enabled Workspace the supervisor is not running, and the cloud did not park. */
  WORKSPACE_NOT_RUNNING: "LIFECYCLE_WORKSPACE_NOT_RUNNING",
  /** A Workspace that was stopped and whose process is still running. */
  WORKSPACE_STOPPED_BUT_RUNNING: "LIFECYCLE_WORKSPACE_STOPPED_BUT_RUNNING",
} as const;

/** How long a pause waits for Workspace lifecycle work already running, and how often it looks. */
export type LifecycleSettle = { timeoutMs: number; pollMs: number };

export type SupervisorControlOptions = {
  supervisorSocketPath: string;
  supervisorStatePath: string;
  /** Tests shorten it; production uses `LIFECYCLE_SETTLE`. */
  lifecycleSettle?: LifecycleSettle;
};

/**
 * How long a pause waits for the Workspace lifecycle work already running to finish: one
 * restart's runner hold (30 s), its stop, and its readiness (30 s), with room to spare. Work still
 * queued is refused by the pause, so only running work is waited for.
 */
export const LIFECYCLE_SETTLE: LifecycleSettle = { timeoutMs: 120_000, pollMs: 500 };

/** Nothing listens on the supervisor socket: it is missing, or nothing accepts on it. */
export class SupervisorNotRunningError extends Error {
  constructor(options?: ErrorOptions) {
    super("The Computer supervisor is not running.", options);
    this.name = "SupervisorNotRunningError";
  }
}

/** This machine's supervisor socket and state directory, resolved from `os.homedir()` as the
 * installer does (installer/contract/paths.json). */
export function resolveSupervisorPaths(): Pick<
  SupervisorControlOptions,
  "supervisorSocketPath" | "supervisorStatePath"
> {
  const supervisorStatePath = resolveComputerStateDirectory({
    platform: process.platform,
    homeDirectory: homedir(),
    environment: process.env,
  });
  return {
    supervisorStatePath,
    supervisorSocketPath: resolveDaemonSocketPath({
      platform: process.platform,
      stateDirectory: supervisorStatePath,
    }),
  };
}

/**
 * Machine-level control of the running Computer supervisor over its local RPC socket: read its
 * state, pause and resume Workspace launches, and hold and release Agent runners. Shared by the
 * product's own upgrade and `__lifecycle`, through which the installer drives the same steps.
 * The `launch-hold` file is not written or removed here: whoever runs the upgrade transaction
 * owns it, and undoes a failed step by calling `resume`.
 */
export function createSupervisorControl(options: SupervisorControlOptions) {
  const local = new LocalDaemonLauncher({
    // Required by the type, never executed: this client only talks to a running supervisor.
    executablePath: process.execPath,
    socketPath: options.supervisorSocketPath,
    stateDirectory: options.supervisorStatePath,
  });

  /** Runs one socket call, naming a supervisor that is not listening. Only a missing socket or a
   * refused connection means that; a supervisor that answers wrongly is still running. */
  async function reach<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED")
        throw new SupervisorNotRunningError({ cause: error });
      throw error;
    }
  }

  /** The running supervisor's process identity and build version. */
  async function identity(): Promise<{ id?: string; version?: string }> {
    const { daemonId, version } = await reach(() => local.identity());
    return { ...(daemonId ? { id: daemonId } : {}), ...(version ? { version } : {}) };
  }

  async function isRunning(): Promise<boolean> {
    return identity().then(
      () => true,
      () => false,
    );
  }

  /** The bindings the supervisor persisted, read while it is not running. A parked Workspace is
   * down on purpose (the cloud refused it for good), so only an enabled one that is not parked is
   * a problem. */
  async function persistedStatus(): Promise<SupervisorStatus> {
    const file = Bun.file(join(options.supervisorStatePath, "bindings.json"));
    const persisted = (await file.exists())
      ? ((await file.json()) as { workspaceId: string; enabled: boolean }[])
      : [];
    const problems: SupervisorProblem[] = [];
    for (const binding of persisted) {
      if (!binding.enabled) continue;
      const health = await new WorkspaceHealthJournal(
        workspaceHealthJournalPath(
          workspaceStateDirectory(options.supervisorStatePath, binding.workspaceId),
        ),
      ).state();
      if (health.status === "parked") continue;
      problems.push({
        code: SUPERVISOR_PROBLEM_CODE.SUPERVISOR_NOT_RUNNING,
        message:
          "configured running bindings have no healthy supervisor. Run 'coforge-computer start' to recover them, then upgrade again.",
      });
      break;
    }
    return {
      supervisor: { running: false },
      bindings: persisted.map((binding) => ({
        bindingId: binding.workspaceId,
        enabled: binding.enabled,
        running: false,
        processId: null,
      })),
      problems,
    };
  }

  /** The running supervisor's own snapshot. A parked Workspace is enabled but down on purpose; it
   * is neither a problem nor started again by an upgrade. */
  async function runningStatus(): Promise<SupervisorStatus> {
    const supervisor = await identity();
    const runtimes = await reach(() => local.control("snapshot"));
    return {
      supervisor: { running: true, ...supervisor },
      bindings: runtimes.map((runtime) => ({
        bindingId: runtime.workspaceId,
        enabled: runtime.enabled,
        running: runtime.processId > 0,
        processId: runtime.processId || null,
      })),
      problems: runtimes.flatMap((runtime): SupervisorProblem[] => {
        const id = runtime.workspaceId;
        if (runtime.processId > 0 && !runtime.enabled)
          return [
            {
              code: SUPERVISOR_PROBLEM_CODE.WORKSPACE_STOPPED_BUT_RUNNING,
              bindingId: id,
              message: `Workspace ${id} is stopped but still running. Run 'coforge-computer stop --workspace ${id}', then upgrade again.`,
            },
          ];
        if (runtime.processId === 0 && runtime.enabled && runtime.parkReason === undefined)
          return [
            {
              code: SUPERVISOR_PROBLEM_CODE.WORKSPACE_NOT_RUNNING,
              bindingId: id,
              message: `Workspace ${id} is enabled but not running. Run 'coforge-computer start --workspace ${id}' (or 'coforge-computer stop --workspace ${id}' to leave it stopped), then upgrade again.`,
            },
          ];
        return [];
      }),
    };
  }

  /** The running supervisor's state, or the persisted bindings when it is not running. */
  async function status(): Promise<SupervisorStatus> {
    try {
      return await runningStatus();
    } catch (error) {
      if (error instanceof SupervisorNotRunningError) return persistedStatus();
      throw error;
    }
  }

  /** Stops new Workspace lifecycle work at once, then waits, bounded, for the work already
   * running to finish. A failure leaves launches paused; the caller undoes it with `resume`. */
  async function pause(requestId: string): Promise<void> {
    await reach(() => local.control("pause", undefined, requestId));
    logger.info("Workspace launches paused", {
      event: "upgrade:launches_paused",
      request_id: requestId,
    });
    await settleLifecycleWork(local, options.lifecycleSettle ?? LIFECYCLE_SETTLE);
  }

  /** Stops every Agent admitting new turns and waits, bounded, for in-flight work to finish. */
  async function hold(requestId?: string): Promise<RunnerHoldOutcome> {
    // The wait below treats a hold it cannot apply as nothing to wait for, so a supervisor that is
    // not running has to be named before it starts.
    await identity();
    const outcome = await holdRunnersUntilQuiescent({
      hold: async () => {
        const response = await local.hold("hold", undefined, requestId);
        if (!response.accepted) throw new Error("Supervisor did not accept the runner hold");
        return response;
      },
      // The wait itself lives in the daemon package, shared with the supervisor's restart hold.
      // Keep this path's own logger and `upgrade:` event names.
      logger,
      eventPrefix: "upgrade",
    });
    logger.info("Runner hold completed", {
      event: outcome.quiescent ? "upgrade:runner_hold_quiescent" : "upgrade:runner_hold_expired",
      operation: "hold",
      request_id: requestId,
      quiescent: outcome.quiescent,
      elapsed_ms: outcome.elapsedMs,
      busy_agent_count: outcome.busyAgents.length,
      unreachable_workspace_ids: outcome.unreachableWorkspaceIds,
    });
    return outcome;
  }

  /** Lifts the runner hold. Idempotent while the supervisor runs. */
  async function release(): Promise<void> {
    await reach(() => local.hold("release"));
    logger.info("Runner hold released", { event: "upgrade:runner_hold_released" });
  }

  /** Lifts the runner hold, then lets Workspace launches proceed. Releasing first is what lifts a
   * hold on an upgrade aborted before the stop; on the success path the supervisor answering is a
   * fresh process that was never held, and the release is a no-op. */
  async function resume(requestId: string): Promise<void> {
    await local.hold("release").catch(() => {});
    await reach(() => local.control("resume", undefined, requestId));
    logger.info("Workspace launches resumed", {
      event: "upgrade:launches_resumed",
      request_id: requestId,
    });
  }

  return {
    identity,
    isRunning,
    persistedStatus,
    runningStatus,
    status,
    pause,
    hold,
    release,
    resume,
  };
}

export type SupervisorControl = ReturnType<typeof createSupervisorControl>;

/**
 * Waits until no Workspace start, restart, or configure is under way (`lifecycleUnderWay` in the
 * supervisor's snapshot), or gives up naming them.
 */
async function settleLifecycleWork(
  local: LocalDaemonLauncher,
  settle: LifecycleSettle,
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
