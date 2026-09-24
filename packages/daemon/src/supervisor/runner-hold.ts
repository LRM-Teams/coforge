import { getLogger, type Logger } from "@logtape/logtape";
import type { HeldBusyAgent } from "@lrm/coforge-sdk/internal";

/**
 * How long a lifecycle operation lets in-flight Agent work finish after the runner hold is
 * engaged. Past this bound the operation stops the daemon regardless: an Agent that will not
 * finish must not be able to pin a machine on an old version, or to block a restart. Without the
 * hold the effective grace period is the ~2s SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()`.
 */
export const RUNNER_HOLD_MS = 30_000;

/** How often the hold is re-asked for the busy set. `daemon:hold` is idempotent, so a poll is
 * simply a repeat call; 250ms keeps the common "already idle" case effectively instant. */
export const RUNNER_HOLD_POLL_MS = 250;

/**
 * Settles with `answer`, or rejects with `message` once `timeoutMs` passes. The timer is always
 * cleared: racing against a bare `Bun.sleep` leaves the losing sleep pending, which keeps the
 * event loop - and so the process - alive for the full timeout after the caller has moved on. An
 * upgrade's last hold lands just before the stop, so that pending sleep made the Coordinator
 * outlive its own shutdown by exactly launchd's 5 s SIGKILL window.
 */
export async function answeredWithin<T>(
  answer: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  /**
   * Where this module's own two log lines go, and what prefixes their event names. Each caller
   * owns a different pair: the Computer upgrade keeps `coforge.computer.upgrade` and `upgrade:`
   * so its existing log contract is unchanged, while the Coordinator's restart uses
   * `coforge.daemon.supervisor` and `restart:`. The defaults are the Coordinator's, because that
   * is the process this module lives in.
   */
  logger?: Logger;
  eventPrefix?: string;
  holdMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called once per Agent still busy at the deadline; defaults to a structured log line. */
  onDeadline?: (entry: Record<string, unknown>) => void;
};

/**
 * Holds every runner under a daemon and waits, up to `holdMs`, for its Agents to go idle.
 *
 * Every failure mode resolves towards "proceed": a hold that cannot be asked, or that starts
 * failing mid-poll, returns quiescent, and Workspaces the Coordinator reported unreachable are
 * counted as idle. The hold is a courtesy to in-flight tool calls, never a gate on the operation
 * that asked for it.
 */
export async function holdRunnersUntilQuiescent(
  options: RunnerHoldOptions,
): Promise<RunnerHoldOutcome> {
  const {
    hold,
    logger = getLogger(["coforge", "daemon", "supervisor"]),
    eventPrefix = "restart",
    holdMs = RUNNER_HOLD_MS,
    pollMs = RUNNER_HOLD_POLL_MS,
    now = Date.now,
    sleep = Bun.sleep,
    onDeadline = (entry) =>
      logger.warn("Agent was still busy when the runner hold expired; stopping anyway", entry),
  } = options;
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  let snapshot: RunnerHoldSnapshot = { busyAgents: [], unreachableWorkspaceIds: [] };

  while (true) {
    try {
      snapshot = await hold();
    } catch (error) {
      logger.warn("Runner hold could not be applied; continuing without it", {
        event: `${eventPrefix}:runner_hold_failed`,
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
      event: `${eventPrefix}:runner_hold_deadline`,
      workspace_id: agent.workspaceId,
      agent_id: agent.agentId,
      detail_kind: agent.detailKind,
      elapsed_ms: elapsed(),
    });
  return { ...snapshot, quiescent: false, elapsedMs: elapsed() };
}
