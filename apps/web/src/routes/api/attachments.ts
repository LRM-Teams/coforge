import { createFileRoute } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import { requireBrowserUser } from "#/server/auth/require-user.server";
import { storeAttachment } from "#/server/attachments/attachment.server";
import { getDatabaseClient } from "#/server/db/client.server";

export const Route = createFileRoute("/api/attachments")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
        const form = await request.formData();
        const conversationId = form.get("conversationId");
        const file = form.get("file");
        if (typeof conversationId !== "string" || !(file instanceof File))
          return new Response("invalid attachment", { status: 400 });
        const db = getDatabaseClient();
        if (!db) return new Response("persistence unavailable", { status: 503 });
        try {
          return Response.json(
            await storeAttachment(db, { userId: user.id, conversationId, file }),
          );
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "upload failed", {
            status: 403,
          });
        }
      },
    },
  },
});
