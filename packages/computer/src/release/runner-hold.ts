import { getLogger } from "@logtape/logtape";
import type { HeldBusyAgent } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "computer", "upgrade"]);

/**
 * How long an upgrade lets in-flight Agent work finish after the runner hold is engaged. Past this
 * bound the upgrade stops the supervisor regardless: an Agent that will not finish must not be able
 * to pin a machine on an old version. Before this existed the effective grace period was the ~2s
 * SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()` (ADR 0020).
 */
export const UPGRADE_RUNNER_HOLD_MS = 30_000;

/** How often the hold is re-asked for the busy set. `daemon:hold` is idempotent, so a poll is
 * simply a repeat call; 250ms keeps the common "already idle" case effectively instant. */
export const UPGRADE_RUNNER_HOLD_POLL_MS = 250;

export type RunnerHoldSnapshot = {
  busyAgents: readonly HeldBusyAgent[];
  unreachableWorkspaceIds: readonly string[];
};

export type RunnerHoldOutcome = RunnerHoldSnapshot & {
  /** True when every Agent reached an idle/terminal Activity before the bound elapsed. */
  quiescent: boolean;
  elapsedMs: number;
};

export type RunnerHoldOptions = {
  /** Engages the hold and reports the current busy set. Must be idempotent. */
  hold: () => Promise<RunnerHoldSnapshot>;
  holdMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called once per Agent still busy at the deadline; defaults to a structured log line. */
  onDeadline?: (entry: Record<string, unknown>) => void;
};

/**
 * Holds every runner under a Coordinator and waits, up to `holdMs`, for the Agents to go idle.
 *
 * Every failure mode resolves towards "proceed": a hold that cannot be asked, or that starts
 * failing mid-poll, returns quiescent, and Workspaces the Coordinator reported unreachable are
 * counted as idle. The hold is a courtesy to in-flight tool calls, never a gate on the upgrade.
 */
export async function holdRunnersUntilQuiescent(
  options: RunnerHoldOptions,
): Promise<RunnerHoldOutcome> {
  const {
    hold,
    holdMs = UPGRADE_RUNNER_HOLD_MS,
    pollMs = UPGRADE_RUNNER_HOLD_POLL_MS,
    now = Date.now,
    sleep = Bun.sleep,
    onDeadline = defaultDeadlineLog,
  } = options;
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  let snapshot: RunnerHoldSnapshot = { busyAgents: [], unreachableWorkspaceIds: [] };

  while (true) {
    try {
      snapshot = await hold();
    } catch (error) {
      logger.warn("Runner hold could not be applied; continuing with the upgrade", {
        event: "upgrade:runner_hold_failed",
        elapsed_ms: elapsed(),
        error_message: error instanceof Error ? error.message : String(error),
      });
      return { ...snapshot, busyAgents: [], quiescent: true, elapsedMs: elapsed() };
    }
    if (snapshot.busyAgents.length === 0)
      return { ...snapshot, quiescent: true, elapsedMs: elapsed() };
    if (elapsed() >= holdMs) break;
    await sleep(pollMs);
  }

  for (const agent of snapshot.busyAgents)
    onDeadline({
      event: "upgrade:runner_hold_deadline",
      workspace_id: agent.workspaceId,
      agent_id: agent.agentId,
      detail_kind: agent.detailKind,
      elapsed_ms: elapsed(),
    });
  return { ...snapshot, quiescent: false, elapsedMs: elapsed() };
}

function defaultDeadlineLog(entry: Record<string, unknown>): void {
  logger.warn("Agent was still busy when the runner hold expired; stopping anyway", entry);
}
