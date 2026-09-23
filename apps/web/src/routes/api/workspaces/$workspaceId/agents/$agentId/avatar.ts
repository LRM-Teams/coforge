import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { AppError, isAppError } from "#src/lib/app-error";
import { AgentAvatars } from "#src/server/agents/agent-avatar.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";

const ids = z.object({ workspaceId: z.uuid(), agentId: z.uuid() });

export const Route = createFileRoute("/api/workspaces/$workspaceId/agents/$agentId/avatar")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
          if (!user) throw new AppError("ACCESS_DENIED");
          if (!ids.safeParse(params).success) throw new AppError("NOT_FOUND");
          const image = await new AgentAvatars(requireDatabaseClient()).read(
            user.id,
            params.workspaceId,
            params.agentId,
          );
          return new Response(image.body, {
            headers: {
              "Content-Type": image.contentType,
              "Content-Disposition": "inline",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, max-age=31536000, immutable",
              Vary: "Cookie",
            },
          });
        } catch (error) {
          if (!isAppError(error)) throw error;
          const status =
            error.code === "ACCESS_DENIED" ? 401 : error.code === "NOT_FOUND" ? 404 : 503;
          return Response.json(
            { code: error.code },
            { status, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
