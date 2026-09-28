import { createFileRoute } from "@tanstack/react-router";

import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { notificationOpenResponse } from "#src/server/notifications/open-notification.server";

export const Route = createFileRoute("/notifications/open")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await requireBrowserUser(request.headers.get("cookie") ?? undefined);
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
