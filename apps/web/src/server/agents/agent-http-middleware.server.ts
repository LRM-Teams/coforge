import { createMiddleware } from "@tanstack/react-start";
import { getDatabaseClient } from "#src/server/db/client.server";
import { authenticateAgentHttpRequest } from "./agent-api-http.server";

/**
 * Authentication boundary for the Agent HTTP API. The daemon presents its own
 * API key plus the Agent's; both must be bound to the same Computer and
 * Workspace. Routes receive the resolved principal and the database it was
 * verified against.
 *
 * Every answer this boundary produces is `cache-control: no-store` — the
 * payloads are one Agent's view of one Workspace, so nothing between the
 * daemon and us should keep a copy, and the refusals are no different. Two of
 * the routes below (`github-credentials`, `github-commit-trailers`) set that
 * header themselves and may keep doing so — belt and braces on the routes that
 * carry credentials — but no route has to.
 */
const NO_STORE = { "cache-control": "no-store" } as const;

export const agentAuthMiddleware = createMiddleware().server(async ({ next, request }) => {
  const db = getDatabaseClient();
  if (!db) return new Response("unauthorized", { status: 401, headers: NO_STORE });
  try {
    const principal = await authenticateAgentHttpRequest(request, db);
    const response = await next({ context: { principal, db } });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    return new Response("unauthorized", { status: 401, headers: NO_STORE });
  }
});
