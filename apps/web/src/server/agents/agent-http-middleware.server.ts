import { createMiddleware } from "@tanstack/react-start";
import { getDatabaseClient } from "#src/server/db/client.server";
import { authenticateAgentHttpRequest } from "./agent-api-http.server";

/**
 * Authentication boundary for the Agent HTTP API. The daemon presents its own
 * API key plus the Agent's; both must be bound to the same Computer and
 * Workspace. Routes receive the resolved principal and the database it was
 * verified against.
 *
 * Every answer this boundary produces is `cache-control: no-store`: an Agent's
 * view of one Workspace should not be kept by anything between the daemon and
 * us, and a refusal is no different. Two of the routes below
 * (`github-credentials`, `github-commit-trailers`) had set that header
 * themselves and may keep doing so — belt and braces on the routes that carry
 * credentials — but no route has to.
 *
 * The header is applied to a copy rather than by mutating the handler's
 * response. Setting a header on a `Response` is only guaranteed to work while
 * its headers are mutable — Bun is lenient today, stricter runtimes are not —
 * and this code sits inside the `try` above, where a throw would turn a
 * working authenticated request into a 401 "unauthorized". One extra object
 * per request is cheaper than that failure mode.
 */
const NO_STORE = { "cache-control": "no-store" } as const;

export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const agentAuthMiddleware = createMiddleware().server(async ({ next, request }) => {
  const db = getDatabaseClient();
  if (!db) return new Response("unauthorized", { status: 401, headers: NO_STORE });
  try {
    const principal = await authenticateAgentHttpRequest(request, db);
    const result = await next({ context: { principal, db } });
    result.response = noStore(result.response);
    return result;
  } catch {
    return new Response("unauthorized", { status: 401, headers: NO_STORE });
  }
});
