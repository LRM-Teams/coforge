import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError, isAppError } from "../../lib/app-error";
import { optionalBrowserUser } from "../../server/auth/require-user.server";
import { requireDatabaseClient } from "../../server/db/client.server";
import { configuredGitHub } from "../../server/integrations/github-config.server";

/** Streams one repository file as a download, read with the requesting User's GitHub token. */
export const Route = createFileRoute("/api/projects/$projectId/raw/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = optionalBrowserUser(request.headers.get("cookie") ?? undefined);
          if (!user) throw new AppError("ACCESS_DENIED");
          if (!z.uuid().safeParse(params.projectId).success) throw new AppError("NOT_FOUND");
          const path = params._splat ?? "";
          const project = await requireDatabaseClient().project.findFirst({
            where: { id: params.projectId, workspace: { members: { some: { userId: user.id } } } },
            select: { githubInstallationId: true, githubRepositoryId: true, githubFullName: true },
          });
          if (
            !project?.githubFullName ||
            !project.githubInstallationId ||
            !project.githubRepositoryId
          )
            throw new AppError("NOT_FOUND");
          const github = await configuredGitHub();
          if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
          const file = await github.connection.repositoryRaw(
            user.id,
            {
              installationId: project.githubInstallationId,
              repositoryId: project.githubRepositoryId,
              fullName: project.githubFullName,
            },
            path,
          );
          const name = path.split("/").pop() || "file";
          return new Response(file.body, {
            headers: {
              // Repository content is untrusted: never let the browser render it on this origin.
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
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
