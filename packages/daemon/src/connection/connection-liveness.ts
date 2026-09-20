/**
 * How long the Daemon's cloud connection may carry nothing at all before CoForge stops believing
 * it. An open socket is not evidence: the connection that prompted this stayed open, kept its
 * subscription, and delivered frames the Daemon could not act on, while the Agent behind it sat
 * silent until someone restarted the Computer by hand.
 *
 * Inbound traffic here means anything that proves the link still carries data in both
 * directions - a publication on the Daemon's own channel, or a reply to the status RPC the
 * connection already sends every 30 seconds. A Workspace with nothing to say still produces the
 * second, so a quiet Workspace is never mistaken for a dead connection.
 */
export const INBOUND_QUIET_MS = 70_000;

/** When a connection has carried nothing for this long, it is rebuilt rather than waited on.
 * Four consecutive 30-second status round trips have to go unanswered before the fifth refresh
 * finds this window crossed, so a connection is never rebuilt over a single lost reply. The
 * relationship to that interval is asserted in `connection-liveness.test.ts`, because these
 * windows are only meaningful in refreshes. */
export const INBOUND_STALLED_MS = 140_000;

export type ConnectionLiveness = "carrying" | "quiet" | "stalled";

/** What the Daemon should make of a connection whose last inbound traffic was this long ago. */
export function connectionLiveness(lastInboundAgeMs: number): ConnectionLiveness {
  if (lastInboundAgeMs >= INBOUND_STALLED_MS) return "stalled";
  if (lastInboundAgeMs >= INBOUND_QUIET_MS) return "quiet";
  return "carrying";
}
