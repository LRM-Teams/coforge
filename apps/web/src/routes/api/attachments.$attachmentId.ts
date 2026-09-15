import { createFileRoute } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import { requireBrowserUser } from "#/server/auth/require-user.server";
import { attachmentResponseHeaders } from "#/server/attachments/attachment-response.server";
import { readAuthorizedAttachment } from "#/server/attachments/attachment.server";
import { getDatabaseClient } from "#/server/db/client.server";

export const Route = createFileRoute("/api/attachments/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
        const db = getDatabaseClient();
        if (!db) return new Response("persistence unavailable", { status: 503 });
        try {
          const { attachment, open } = await readAuthorizedAttachment(db, {
            attachmentId: params.attachmentId,
            userId: user.id,
          });
          const file = await open();
          const forceDownload = new URL(request.url).searchParams.has("download");
          return new Response(file.body, {
            headers: attachmentResponseHeaders(attachment, forceDownload),
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    },
  },
});
