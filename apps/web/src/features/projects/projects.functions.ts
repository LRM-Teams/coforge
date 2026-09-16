import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../../server/auth/function-auth";
import { requireDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { configuredGitHub } from "../../server/integrations/github-config.server";
import { AppError } from "../../lib/app-error";
import { z } from "zod";

export const getProject = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const db = requireDatabaseClient();
    const workspaceId = await requireWorkspaceIdForRequest(db, context.user.id);
    return db.project.findFirst({
      where: { workspaceId, slug: data.slug },
      select: {
        id: true,
        name: true,
        slug: true,
        githubFullName: true,
        githubHtmlUrl: true,
        developmentConversation: { select: { id: true } },
      },
    });
  });

export const listProjects = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const db = requireDatabaseClient();
    const workspaceId = await requireWorkspaceIdForRequest(db, context.user.id);
    return db.project.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        developmentConversation: { select: { id: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  });

export const createProject = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      name: z.string().trim().min(1).max(100),
      slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(100),
      installationId: z.number().int().positive(),
      repositoryId: z.number().int().positive(),
      fullName: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .max(300),
    }),
  )
  .handler(async ({ data, context }) => {
    const db = requireDatabaseClient();
    const workspaceId = await requireWorkspaceIdForRequest(db, context.user.id);
    const github = await configuredGitHub();
    if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const repositories = await github.connection.repositories(
      context.user.id,
      data.installationId,
      1,
    );
    const repository = repositories.repositories.find(
      (item) => item.id === data.repositoryId && item.fullName === data.fullName,
    );
    if (!repository) throw new AppError("ACCESS_DENIED");
    return db.project.create({
      data: {
        workspaceId,
        name: data.name,
        slug: data.slug,
        githubInstallationId: data.installationId,
        githubRepositoryId: data.repositoryId,
        githubFullName: data.fullName,
        githubHtmlUrl: `https://github.com/${repository.fullName}`,
        developmentConversation: {
          create: {
            workspaceId,
            channelName: data.slug,
            members: { create: { workspaceId, userId: context.user.id } },
          },
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        developmentConversation: { select: { id: true } },
      },
    });
  });
