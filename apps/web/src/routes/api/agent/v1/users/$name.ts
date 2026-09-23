import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import { resolveAgentUserInfo } from "@/server/agents/agent-user-info.server";

/** `GET /api/agent/v1/users/:name` — `coforge user info <name>`.
 * Same `{ ok, ... }` / `{ ok: false, errorCode, error }` envelope as the Agent Manual
 * routes. `:name` is the Username without a leading `@`; the CLI strips it before calling here. */
export const Route = createFileRoute("/api/agent/v1/users/$name")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db }, params }) => {
        const outcome = await resolveAgentUserInfo(db, principal, params.name);
        return Response.json(outcome.body, { status: outcome.status });
      },
    },
  },
});
