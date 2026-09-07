import { createFileRoute } from "@tanstack/react-router";

import { requireBrowserUser } from "@/server/auth/require-user.server";
import { getDatabaseClient } from "@/server/db/client.server";
import { notificationOpenResponse } from "@/server/notifications/open-notification.server";

export const Route = createFileRoute("/notifications/open")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = requireBrowserUser(request.headers.get("cookie") ?? undefined);
        const db = getDatabaseClient();
        if (!db) return new Response(null, { status: 503 });
        return notificationOpenResponse({
          request,
          userId: user.id,
          canAccessWorkspace: async (userId, slug) =>
            Boolean(
              await db.workspace.findFirst({
                where: { slug, members: { some: { userId } } },
                select: { id: true },
              }),
            ),
        });
      },
    },
  },
});
