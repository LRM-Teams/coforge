import { createFileRoute } from "@tanstack/react-router";

import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { recordCatalog } from "#src/server/records/record-catalog.server";

export const Route = createFileRoute(
  "/api/workspaces/$workspaceSlug/weekly-reports/$reportId/presentation",
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await requireBrowserUser(request.headers.get("cookie") ?? undefined);
          const db = getDatabaseClient();
          if (!db) return new Response("persistence unavailable", { status: 503 });
          const workspace = await db.workspace.findUnique({
            where: { slug: params.workspaceSlug },
            select: { id: true },
          });
          if (!workspace) return new Response("not found", { status: 404 });
          const result = await recordCatalog(db).exportWeeklyReportPresentation({
            workspaceId: workspace.id,
            userId: user.id,
            overviewReportId: params.reportId,
          });
          return new Response(result.bytes.slice().buffer as ArrayBuffer, {
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    },
  },
});
