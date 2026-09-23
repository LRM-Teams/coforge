import { createMiddleware } from "@tanstack/react-start";
import { getDatabaseClient } from "#src/server/db/client.server";
import { authenticateAgentHttpRequest } from "./agent-api-http.server";

/**
 * Authentication boundary for the Agent HTTP API. The daemon presents its own
 * API key plus the Agent's; both must be bound to the same Computer and
 * Workspace. Routes receive the resolved principal and the database it was
 * verified against.
 */
export const agentAuthMiddleware = createMiddleware().server(async ({ next, request }) => {
  const db = getDatabaseClient();
  if (!db) return new Response("unauthorized", { status: 401 });
  try {
    const principal = await authenticateAgentHttpRequest(request, db);
    return next({ context: { principal, db } });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
});
