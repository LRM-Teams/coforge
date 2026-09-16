import { createServerFn } from "@tanstack/react-start";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import { configuredGitHub } from "../../server/integrations/github-config.server";
import { AppError } from "../../lib/app-error";
import { z } from "zod";

export const getProject = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const { db, workspaceId } = context;
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
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { db, workspaceId } = context;
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
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      name: z.string().trim().min(1).max(100),
      slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(100),
      installationId: z.number().int().positive().safe().optional(),
      repositoryId: z.number().int().positive().safe().optional(),
      fullName: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .max(300)
        .optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { db, workspaceId } = context;
    let repository: { id: number; fullName: string; installationId: number } | undefined;
    if (data.installationId || data.repositoryId || data.fullName) {
      if (!data.installationId || !data.repositoryId || !data.fullName)
        throw new AppError("ACCESS_DENIED");
      const github = await configuredGitHub();
      if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
      repository = (await github.connection.accessibleRepositories(context.user.id)).find(
        (item) => item.id === data.repositoryId && item.fullName === data.fullName,
      );
      if (!repository || repository.installationId !== data.installationId)
        throw new AppError("ACCESS_DENIED");
    }
    return db.project.create({
      data: {
        workspaceId,
        name: data.name,
        slug: data.slug,
        githubInstallationId: data.installationId,
        githubRepositoryId: data.repositoryId,
        githubFullName: data.fullName,
        githubHtmlUrl: repository ? `https://github.com/${repository.fullName}` : null,
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
