import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { handleMemoryAgentHttp } from "#src/server/workspace-memory/memory-agent-http.server";

export const Route = createFileRoute("/api/agent/v1/openviking")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        return handleMemoryAgentHttp({
          db,
          workspaceId: principal.workspaceId,
          agentId: principal.agentId,
          request,
          body: await request.json(),
        });
      },
    },
  },
});
