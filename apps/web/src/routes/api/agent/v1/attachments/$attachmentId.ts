import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { readAuthorizedAttachment } from "#/server/attachments/attachment.server";
import { getDatabaseClient } from "#/server/db/client.server";

export const Route = createFileRoute("/api/agent/v1/attachments/$attachmentId")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context, params }) => {
        try {
          const principal = context.principal;
          const db = getDatabaseClient();
          if (!db) return new Response("persistence unavailable", { status: 503 });
          const { attachment, open } = await readAuthorizedAttachment(db, {
            attachmentId: params.attachmentId,
            agentId: principal.agentId,
          });
          const file = await open();
          return new Response(file.body, {
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
