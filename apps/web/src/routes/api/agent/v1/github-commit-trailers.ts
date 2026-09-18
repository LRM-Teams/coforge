import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { resolveGitHubCommitTrailers } from "#/server/integrations/github-commit-trailers.server";

const requestSchema = z.object({ repository: z.string().min(1).nullable() }).strict();

export const Route = createFileRoute("/api/agent/v1/github-commit-trailers")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        try {
          const { repository } = requestSchema.parse(await request.json());
          const trailers = await resolveGitHubCommitTrailers(db, principal.workspaceId, repository);
          return Response.json({ trailers }, { headers: { "cache-control": "no-store" } });
        } catch {
          return new Response("GitHub commit trailers request failed", { status: 400 });
        }
      },
    },
  },
});
