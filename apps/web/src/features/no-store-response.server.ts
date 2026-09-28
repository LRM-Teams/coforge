import { setResponseHeader } from "@tanstack/react-start/server";

/**
 * Every server function whose payload is scoped to one viewer or one agent declares this before it
 * reads or writes anything: the payload must never be cached, by the browser or by a proxy in front
 * of it.
 *
 * It is a function rather than a bare `setResponseHeader` call so the convention is something a
 * guard can see — `test/agent-endpoints-no-store.test.ts` counts declarations against server
 * functions per file — instead of a header name that every endpoint has to spell correctly on its
 * own. Adding something to this response (a `vary`, a second header) belongs here too.
 */
export function declareNoStore(): void {
  setResponseHeader("cache-control", "no-store");
}
