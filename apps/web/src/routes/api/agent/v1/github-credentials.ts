import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import { configuredGitHub } from "@/server/integrations/github-config.server";
import { isAppError } from "@/lib/app-error";

const requestSchema = z.object({}).strict();

export const Route = createFileRoute("/api/agent/v1/github-credentials")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal } }) => {
        try {
          const github = await configuredGitHub();
          if (!github)
            return new Response("GitHub Agent credentials are unavailable", { status: 503 });
          requestSchema.parse(await request.json());
          const credential = await github.connection.credential(principal.userId);
          return Response.json(credential, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          if (isAppError(error) && error.code === "ACCESS_DENIED")
            return new Response("GitHub connection is not authorized", { status: 403 });
          return new Response("GitHub credential request failed", { status: 503 });
        }
      },
    },
  },
});
