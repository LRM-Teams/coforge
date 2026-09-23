import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import {
  resolveAgentProfileShow,
  resolveAgentProfileUpdate,
} from "@/server/agents/agent-profile.server";

/** `GET /api/agent/v1/profile[?target=<name>]` — `coforge profile show [<target>]`; defaults to
 * the calling Agent's own profile. `POST /api/agent/v1/profile` — `coforge profile update`,
 * applies only to the calling Agent. Same `{ ok, ... }` / `{ ok: false, errorCode, error }`
 * envelope as the Agent Manual and `user info` routes. */
export const Route = createFileRoute("/api/agent/v1/profile")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ request, context: { principal, db } }) => {
        const target = new URL(request.url).searchParams.get("target")?.trim() || undefined;
        const outcome = await resolveAgentProfileShow(db, principal, target);
        return Response.json(outcome.body, { status: outcome.status });
      },
      POST: async ({ request, context: { principal, db } }) => {
        const body = (await request.json().catch(() => undefined)) as
          | { displayName?: unknown; description?: unknown }
          | undefined;
        const outcome = await resolveAgentProfileUpdate(db, principal, body ?? {});
        return Response.json(outcome.body, { status: outcome.status });
      },
    },
  },
});
