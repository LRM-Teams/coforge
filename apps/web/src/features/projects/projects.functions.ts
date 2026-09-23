import { createServerFn } from "@tanstack/react-start";
import type { PrismaClient } from "#src/generated/prisma/client";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { configuredGitHub } from "#src/server/integrations/github-config.server";
import type { RepositorySelection } from "#src/server/integrations/github-connection.server";
import { gitObjectIdSchema } from "#src/lib/git-object-id";
import { linkedRepositoryOf } from "#src/server/projects/project-files.server";
import { AppError, isAppError } from "#src/lib/app-error";
import { ProjectSettings } from "#src/server/projects/project-settings.server";
import { z } from "zod";
import { createProjectInput, projectIconUploadInput, updateProjectInput } from "./projects.schemas";
import { ProjectImages, projectIconUrl } from "#src/server/projects/project-images.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

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
    if (!project.githubFullName) return { status: "unlinked" as const };
    if (!project.githubInstallationId || !project.githubRepositoryId)
      return { status: "denied" as const };
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

type GitHubReads = NonNullable<Awaited<ReturnType<typeof configuredGitHub>>>["connection"];

/**
 * Shared shell of the file-browser reads: resolves the Project's linked repository, runs one
 * GitHub read, and maps failures to a status the page renders inline instead of an error page.
 */
async function readLinkedRepository<T>(
  context: { db: PrismaClient; workspaceId: string },
  slug: string,
  read: (github: GitHubReads, repository: RepositorySelection) => Promise<T>,
) {
  const project = await context.db.project.findFirst({
    where: { workspaceId: context.workspaceId, slug },
    select: { githubInstallationId: true, githubRepositoryId: true, githubFullName: true },
  });
  if (!project) throw new AppError("NOT_FOUND");
  const repository = linkedRepositoryOf(project);
  if (!repository) return { status: "unlinked" as const };
  try {
    const github = await configuredGitHub();
    if (!github) return { status: "unavailable" as const };
    const result = await read(github.connection, repository);
    return { status: "ready" as const, fullName: repository.fullName, ...result };
  } catch (error) {
    if (isAppError(error) && error.code === "ACCESS_DENIED") return { status: "denied" as const };
    if (isAppError(error) && error.code === "NOT_FOUND") return { status: "not_found" as const };
    return { status: "unavailable" as const };
  }
}

/** The whole default-branch tree; the file browser fetches it once and expands folders locally. */
export const getProjectTree = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(({ data, context }) =>
    readLinkedRepository(context, data.slug, (github, repository) =>
      github.repositoryTree(context.user.id, repository),
    ),
  );

/** One file (or, when the tree was truncated, one directory). `oid` addresses immutable content. */
export const getProjectObject = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      path: z.string().max(4096),
      oid: gitObjectIdSchema.optional(),
    }),
  )
  .handler(({ data, context }) =>
    readLinkedRepository(context, data.slug, async (github, repository) => ({
      node: await github.repositoryObject(context.user.id, repository, {
        path: data.path,
        oid: data.oid,
      }),
    })),
  );

/** Last commit per entry of one directory, loaded after the listing is already visible. */
export const getProjectDirectoryCommits = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ slug: z.string().min(1), path: z.string().max(4096) }))
  .handler(({ data, context }) =>
    readLinkedRepository(context, data.slug, (github, repository) =>
      github.repositoryDirectoryCommits(context.user.id, repository, data.path),
    ),
  );

export const getProject = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const { db, workspaceId } = context;
    const project = await db.project.findFirst({
      where: { workspaceId, slug: data.slug },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        iconObjectKey: true,
        githubFullName: true,
        githubHtmlUrl: true,
        commitCoAuthor: true,
        conversations: {
          select: {
            id: true,
            channelName: true,
            createdAt: true,
            _count: { select: { members: true, messages: true } },
            messages: {
              take: 1,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: {
                createdAt: true,
                sender: {
                  select: {
                    user: {
                      select: {
                        id: true,
                        displayName: true,
                        username: true,
                        avatarObjectKey: true,
                      },
                    },
                    agent: { select: { displayName: true } },
                  },
                },
              },
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!project) return null;
    const { iconObjectKey, conversations, ...view } = project;
    const mappedConversations = conversations
      .map(({ _count, messages, ...conversation }) => {
        const lastMessage = messages[0];
        const sender = lastMessage?.sender;
        const lastSender = sender
          ? sender.user
            ? {
                name: sender.user.displayName ?? sender.user.username,
                avatarUrl: workspaceUserAvatarUrl(
                  workspaceId,
                  sender.user.id,
                  sender.user.avatarObjectKey,
                ),
              }
            : sender.agent
              ? { name: sender.agent.displayName, avatarUrl: null }
              : null
          : null;
        return {
          ...conversation,
          memberCount: _count.members,
          messageCount: _count.messages,
          lastActivityAt: (lastMessage?.createdAt ?? conversation.createdAt).toISOString(),
          lastSender,
        };
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return {
      ...view,
      conversations: mappedConversations,
      iconUrl: projectIconUrl(project.id, iconObjectKey),
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
  .validator(createProjectInput)
  .handler(async ({ data, context }) => {
    const { db, workspaceId } = context;
    let repository:
      | { id: number; fullName: string; htmlUrl: string; installationId: number | null }
      | undefined;
    if (data.fullName) {
      const github = await configuredGitHub();
      if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
      if (data.installationId && data.repositoryId) {
        const accessible = (await github.connection.accessibleRepositories(context.user.id)).find(
          (item) => item.id === data.repositoryId && item.fullName === data.fullName,
        );
        if (!accessible || accessible.installationId !== data.installationId)
          throw new AppError("ACCESS_DENIED");
        repository = {
          id: accessible.id,
          fullName: accessible.fullName,
          htmlUrl: `https://github.com/${accessible.fullName}`,
          installationId: accessible.installationId,
        };
      } else {
        const publicRepository = await github.connection.lookupPublicRepository(data.fullName);
        repository = { ...publicRepository, installationId: null };
      }
    }
    try {
      return await db.project.create({
        data: {
          workspaceId,
          name: data.name,
          slug: data.slug,
          githubInstallationId: repository?.installationId ?? null,
          githubRepositoryId: repository?.id ?? null,
          githubFullName: repository?.fullName ?? null,
          githubHtmlUrl: repository?.htmlUrl ?? null,
        },
        select: { id: true, name: true, slug: true },
      });
    } catch (error) {
      // The slug is unique per Workspace; surface a taken slug as CONFLICT like workspace creation.
      if (error instanceof Error && "code" in error && error.code === "P2002")
        throw new AppError("CONFLICT");
      throw error;
    }
  });
