import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import { readAuthorizedAttachment } from "@/server/attachments/attachment.server";

export const Route = createFileRoute("/api/agent/v1/attachments/$attachmentId")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db }, params }) => {
        try {
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
