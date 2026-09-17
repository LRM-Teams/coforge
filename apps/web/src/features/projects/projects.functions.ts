import { createServerFn } from "@tanstack/react-start";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import { configuredGitHub } from "../../server/integrations/github-config.server";
import { AppError, isAppError } from "../../lib/app-error";
import { ProjectSettings } from "../../server/projects/project-settings.server";
import { z } from "zod";
import { projectIconUploadInput, updateProjectInput } from "./projects.schemas";
import { ProjectImages, projectIconUrl } from "../../server/projects/project-images.server";
import { isAdminLike } from "../../server/workspaces/member-role.server";
import { workspaceMemberRole } from "../../server/workspaces/members.server";

export const uploadProjectIcon = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(projectIconUploadInput)
  .handler(async ({ data, context }) =>
    new ProjectImages(context.db).store(context.workspaceId, context.user.id, data.id, data.file),
  );

export const getProjectRepository = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const project = await context.db.project.findFirst({
      where: { workspaceId: context.workspaceId, slug: data.slug },
      select: { githubInstallationId: true, githubRepositoryId: true, githubFullName: true },
    });
    if (!project) throw new AppError("NOT_FOUND");
    if (!project.githubFullName || !project.githubInstallationId || !project.githubRepositoryId)
      return { status: "unlinked" as const };
    try {
      const github = await configuredGitHub();
      if (!github) return { status: "unavailable" as const };
      const overview = await github.connection.repositoryOverview(context.user.id, {
        installationId: project.githubInstallationId,
        repositoryId: project.githubRepositoryId,
        fullName: project.githubFullName,
      });
      return { status: "ready" as const, fullName: project.githubFullName, ...overview };
    } catch (error) {
      if (isAppError(error) && error.code === "ACCESS_DENIED") return { status: "denied" as const };
      return { status: "unavailable" as const };
    }
  });

export const getProject = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const { db, workspaceId, user } = context;
    const [project, actorRole] = await Promise.all([
      db.project.findFirst({
        where: { workspaceId, slug: data.slug },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          iconObjectKey: true,
          githubFullName: true,
          githubHtmlUrl: true,
          conversations: {
            select: {
              id: true,
              channelName: true,
              createdAt: true,
              _count: { select: { members: true } },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      }),
      workspaceMemberRole(db, workspaceId, user.id),
    ]);
    if (!project) return null;
    const { iconObjectKey, ...view } = project;
    // Channel creation requires Workspace owner/admin; see PublicChannels.create.
    return {
      ...view,
      iconUrl: projectIconUrl(project.id, iconObjectKey),
      canManageChannels: isAdminLike(actorRole),
    };
  });

export const updateProject = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateProjectInput)
  .handler(async ({ data, context }) => {
    const github = data.repository ? await configuredGitHub() : undefined;
    await new ProjectSettings(context.db, github?.connection).update(
      context.workspaceId,
      context.user.id,
      data,
    );
  });

export const deleteProject = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.uuid(), confirmation: z.string().min(1).max(100) }))
  .handler(async ({ data, context }) => {
    await new ProjectSettings(context.db).delete(
      context.workspaceId,
      context.user.id,
      data.id,
      data.confirmation,
    );
  });

export const listProjects = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { db, workspaceId } = context;
    const projects = await db.project.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        iconObjectKey: true,
        conversations: {
          select: { id: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return projects.map(({ iconObjectKey, ...project }) => ({
      ...project,
      iconUrl: projectIconUrl(project.id, iconObjectKey),
    }));
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
        conversations: {
          create: {
            workspaceId,
            channelName: data.slug,
            members: { create: { userId: context.user.id } },
          },
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        conversations: {
          select: { id: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });
  });
