import { createFileRoute } from "@tanstack/react-router";
import { attachmentCapabilities } from "#/server/attachments/attachment.server";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";

export const Route = createFileRoute("/api/agent/v1/attachments/capabilities")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async () => {
        return Response.json(attachmentCapabilities());
      },
    },
  },
});
