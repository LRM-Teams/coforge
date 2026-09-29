import {
  RUNNER_HOLD_REASONS,
  type DaemonShutdownReason,
  type RunnerHoldReason,
} from "@lrm/coforge-sdk/internal";

/**
 * How recently a runner hold must have been asked for to name the shutdown that follows it. The
 * upgrade and both restarts keep re-asking while they wait for idle Agents (at most
 * `RUNNER_HOLD_MS`, 30 s) and stop the daemon right after, so a hold older than this is one whose
 * operation ended without a release reaching this daemon; it must not label a later plain stop.
 */
export const SHUTDOWN_HOLD_REASON_WINDOW_MS = 60_000;

/** The runner hold in force: why it was asked for, and when it was last asked for. */
export type RunnerHold = { reason: RunnerHoldReason; renewedAtMs: number };

/**
 * The reason a deliberate shutdown gives the server. A runner hold is how the Coordinator, the
 * upgrade, and `coforge-computer restart` announce that they are about to take this daemon down,
 * so a fresh hold names the reason. A shutdown without one is an operator or service stop.
 */
export function shutdownReasonForHold(
  hold: RunnerHold | undefined,
  nowMs: number,
): DaemonShutdownReason {
  if (!hold || nowMs - hold.renewedAtMs > SHUTDOWN_HOLD_REASON_WINDOW_MS) return "computer_stop";
  switch (hold.reason) {
    case RUNNER_HOLD_REASONS.UPGRADE:
      return "computer_upgrade";
    case RUNNER_HOLD_REASONS.WORKSPACE_RESTART:
    case RUNNER_HOLD_REASONS.COMPUTER_RESTART:
      return "computer_restart";
  }
}
