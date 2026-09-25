/**
 * The one Redis URL rule for the web server's Redis-backed caches: `REDIS_URL`, or a failure that
 * names the feature that needed it.
 *
 * Eleven readers kept their own two lines, each naming its own feature — five under `centrifugo/`,
 * three under `agents/`, two under `computers/`, one under `reminders/`. Every caller still names
 * its feature as the argument, so the messages are unchanged.
 *
 * Two neighbours deliberately keep theirs. `agents/agent-control-signal.server.ts` falls back to
 * `LocalAgentControlSignal` when `REDIS_URL` is absent — an optional Redis, not a missing one — so a
 * throwing rule is wrong there. `conversations/redis-message-request-idempotency.server.ts` words
 * its failure as "required to send messages", which this template cannot reproduce; the wording is a
 * product decision, so it stays put.
 *
 * `Bun.env` and `process.env` are the same object under Bun; this reads the former, like the copy
 * it was extracted from.
 */
export function redisUrlFor(feature: string): string {
  const url = Bun.env.REDIS_URL;
  if (!url) throw new Error(`REDIS_URL is required for ${feature}`);
  return url;
}
