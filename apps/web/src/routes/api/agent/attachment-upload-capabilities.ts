import { createFileRoute } from "@tanstack/react-router";
import { attachmentCapabilities } from "#/server/attachments/attachment.server";
import { authenticateAgentHttpRequest } from "#/server/agents/agent-message-http.server";

export const Route = createFileRoute("/api/agent/attachment-upload-capabilities")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await authenticateAgentHttpRequest(request);
        } catch {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json(attachmentCapabilities());
      },
    },
  },
});
