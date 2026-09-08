import { createFileRoute } from "@tanstack/react-router";
import { principalFromAuthorizationHeader } from "@/server/auth/computer-access-token.server";
import { getDatabaseClient } from "@/server/db/client.server";
import { PrismaWorkspaceAccess } from "@/server/db/repositories/setup.repositories.server";

/**
 * Resolves one Workspace by slug for a Computer that has just logged in, so `setup` can confirm
 * the slug before registering. Advertised to the Computer as `coforge_workspaces_endpoint` in the
 * OAuth discovery document.
 *
 * Unlike the realtime path - where Centrifugo checks the token before any RPC reaches us - this
 * is plain HTTP, so the bearer is verified here and the caller is whoever the token was issued
 * to. `findAccessibleBySlug` then scopes the answer to that user's memberships, which is also why
 * a slug the caller is not a member of is a 404 rather than a 403: the response must not reveal
 * that a Workspace exists to someone who cannot see it.
 */
export const Route = createFileRoute("/api/workspaces/$slug")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const principal = await principalFromAuthorizationHeader(request);
        if (!principal)
          return Response.json(
            { error: "unauthorized" },
            { status: 401, headers: { "cache-control": "no-store" } },
          );
        const db = getDatabaseClient();
        if (!db) return Response.json({ error: "unavailable" }, { status: 503 });
        const workspace = await new PrismaWorkspaceAccess(db).getAccessibleBySlug(
          params.slug,
          principal,
        );
        return workspace
          ? Response.json({ workspace }, { headers: { "cache-control": "no-store" } })
          : Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});
