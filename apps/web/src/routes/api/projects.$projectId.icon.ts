import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError, isAppError } from "@/lib/app-error";
import { optionalBrowserUser } from "@/server/auth/require-user.server";
import { requireDatabaseClient } from "@/server/db/client.server";
import { ProjectImages } from "@/server/projects/project-images.server";

export const Route = createFileRoute("/api/projects/$projectId/icon")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
          if (!user) throw new AppError("ACCESS_DENIED");
          if (!z.uuid().safeParse(params.projectId).success) throw new AppError("NOT_FOUND");
          const image = await new ProjectImages(requireDatabaseClient()).read(
            user.id,
            params.projectId,
          );
          return new Response(image.body, {
            headers: {
              "Content-Type": image.contentType,
              "Content-Disposition": "inline",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-cache",
              Vary: "Cookie",
            },
          });
        } catch (error) {
          if (!isAppError(error)) throw error;
          return Response.json(
            { code: error.code },
            {
              status: error.code === "ACCESS_DENIED" ? 401 : error.code === "NOT_FOUND" ? 404 : 503,
              headers: { "Cache-Control": "no-store" },
            },
          );
        }
      },
    },
  },
});
