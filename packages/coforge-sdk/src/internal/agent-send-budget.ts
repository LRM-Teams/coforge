/**
 * The deadlines of one Agent `message send`, shared by the daemon (which issues the Web requests)
 * and the CLI (which waits on the daemon), so the daemon's verdict always reaches the CLI.
 */

/** Each daemon→Web request of a message send gets this deadline (30 s). */
export const AGENT_SEND_REQUEST_TIMEOUT_MS = 30_000;

/** The most daemon→Web requests one `message send` costs: the read that resolves a short thread
 * target, the send, one reconciliation, and one same-key replay. */
export const AGENT_SEND_MAX_REQUESTS = 4;

/** Headroom over the daemon's requests for its local work (draft file, proxy hop). */
const AGENT_SEND_LOCAL_MARGIN_MS = 10_000;

/** The CLI's deadline on one `message send` through the local proxy: every daemon request at its
 * full deadline, plus margin, so the CLI never gives up before the daemon has answered. */
export const AGENT_SEND_LOCAL_DEADLINE_MS =
  AGENT_SEND_MAX_REQUESTS * AGENT_SEND_REQUEST_TIMEOUT_MS + AGENT_SEND_LOCAL_MARGIN_MS;
