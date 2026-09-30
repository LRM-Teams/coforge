import { homedir } from "node:os";
import { join } from "node:path";
import {
  LocalDaemonLauncher,
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";

import { resolveComputerStateDirectory, resolveDaemonSocketPath } from "#src/paths";

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

export type SupervisorStatusOptions = {
  supervisorSocketPath: string;
  supervisorStatePath: string;
};

/** Nothing listens on the supervisor socket: it is missing, or nothing accepts on it. */
class SupervisorNotRunningError extends Error {
  constructor(options?: ErrorOptions) {
    super("The Computer supervisor is not running.", options);
    this.name = "SupervisorNotRunningError";
  }
}

/** This machine's supervisor socket and state directory, resolved from `os.homedir()` as the
 * installer does (installer/contract/paths.json). */
export function resolveSupervisorPaths(): Pick<
  SupervisorStatusOptions,
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
 * Reads what the Computer supervisor is running: over its local RPC socket while it runs, from its
 * persisted bindings while it does not. Shared by the product's own upgrade and `__lifecycle
 * status`, through which the installer reads the same state. It never changes anything.
 */
export function createSupervisorStatusReader(options: SupervisorStatusOptions) {
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

  return { persistedStatus, runningStatus, status };
}

export type SupervisorStatusReader = ReturnType<typeof createSupervisorStatusReader>;
