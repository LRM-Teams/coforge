import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentHttpRequest } from "#/server/agents/agent-message-http.server";
import { readAuthorizedAttachment } from "#/server/attachments/attachment.server";
import { getDatabaseClient } from "#/server/db/client.server";

export const Route = createFileRoute("/api/agent/attachments/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await authenticateAgentHttpRequest(request);
          const db = getDatabaseClient();
          if (!db) return new Response("persistence unavailable", { status: 503 });
          const { attachment, path } = await readAuthorizedAttachment(db, {
            attachmentId: params.attachmentId,
            agentId: principal.agentId,
          });
          return new Response(Bun.file(path), {
            headers: {
              "Content-Type": attachment.contentType,
              "Content-Disposition": `attachment; filename="${attachment.fileName.replace(/["\\\r\n]/g, "_")}"`,
            },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    },
  },
});
