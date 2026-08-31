import { createFileRoute } from "@tanstack/react-router";
import { getDatabaseClient } from "@/server/db/client.server";
import { PrismaWorkspaceAccess } from "@/server/db/repositories/setup.repositories.server";

export const Route = createFileRoute("/api/e2e/workspaces/$slug")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH !== "1")
          return new Response("not found", { status: 404 });
        const auth = request.headers.get("authorization");
        if (!auth?.startsWith("Bearer "))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        const db = getDatabaseClient();
        const workspace = db
          ? await new PrismaWorkspaceAccess(db).getAccessibleBySlug(params.slug, {
              userId: "00000000-0000-5000-8000-000000000001",
            })
          : undefined;
        return workspace
          ? Response.json({ workspace })
          : Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});
