import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { AppError, isAppError } from "#src/lib/app-error";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { privateImageHeaders } from "#src/server/http/image-headers.server";
import { WorkspaceImages } from "#src/server/workspaces/workspace-images.server";

export const Route = createFileRoute("/api/workspaces/$workspaceId/icon")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
          if (!user) throw new AppError("ACCESS_DENIED");
          if (!z.uuid().safeParse(params.workspaceId).success) throw new AppError("NOT_FOUND");
          const image = await new WorkspaceImages(requireDatabaseClient()).read(
            user.id,
            params.workspaceId,
          );
          return new Response(image.body, { headers: privateImageHeaders(image.contentType) });
        } catch (error) {
          if (!isAppError(error)) throw error;
          const status =
            error.code === "ACCESS_DENIED" ? 401 : error.code === "NOT_FOUND" ? 404 : 503;
          return Response.json(
            { code: error.code },
            { status, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
