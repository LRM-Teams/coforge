import type { WorkspaceHealthJournal } from "./workspace-health-journal";

export type WorkspaceRunnerGuardOutcome =
  | { action: "proceed" }
  | { action: "exit"; reason: string; crashCount: number; since: string };

/**
 * The Workspace daemon's own boot-time health decision. There is no process supervising this
 * child's exit - the OS restarts it directly on a non-zero exit - so the child itself is the only
 * place that can notice its predecessor died unexpectedly, and the only place that can decide the
 * restart loop has gone bad often enough to stop itself.
 *
 * Returns `"exit"` when the Workspace is already latched degraded (a prior terminal condition, or
 * this call's own crash just reached the budget); the caller must then exit 0 without starting
 * real Workspace work; exit 0 is what stops both supervisors from restarting it again. Returns
 * `"proceed"` and marks the run live otherwise.
 */
export async function guardWorkspaceRunnerStart(
  journal: WorkspaceHealthJournal,
): Promise<WorkspaceRunnerGuardOutcome> {
  const before = await journal.state();
  if (before.status === "degraded") return { action: "exit", ...degraded(before) };
  if (await journal.wasLeftRunning()) {
    await journal.recordCrash();
    const after = await journal.state();
    if (after.status === "degraded") return { action: "exit", ...degraded(after) };
  }
  await journal.recordStart();
  return { action: "proceed" };
}

function degraded(state: { reason: string; crashCount: number; since: string }) {
  return { reason: state.reason, crashCount: state.crashCount, since: state.since };
}
