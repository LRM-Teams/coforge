import { createFileRoute } from "@tanstack/react-router";
import { attachmentCapabilities } from "#src/server/attachments/attachment.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { getFileStorage } from "#src/server/files/file-storage.server";

export const Route = createFileRoute("/api/agent/v1/attachments/capabilities")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async () => {
        return Response.json(attachmentCapabilities(await getFileStorage()));
      },
    },
  },
});
