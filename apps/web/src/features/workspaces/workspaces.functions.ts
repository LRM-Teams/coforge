import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  createWorkspaceInputSchema,
  deleteWorkspaceInputSchema,
  renameWorkspaceInputSchema,
  workspaceIconUploadInput,
} from "./workspace.schemas";

import { authMiddleware, workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import {
  preferredWorkspaceSlugFromRequest,
  rememberedWorkspaceCookie,
  writePreferredWorkspaceSlug,
} from "#src/server/workspaces/selection.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { WorkspaceDeparture } from "#src/server/workspaces/departure.server";
import {
  centrifugoWorkspaceDeletionSignals,
  WorkspaceDeletion,
} from "#src/server/workspaces/deletion.server";
import { WorkspaceMembers, workspaceMemberRole } from "#src/server/workspaces/members.server";
import { WorkspaceImages } from "#src/server/workspaces/workspace-images.server";
import { MEMBER_PAGE_MAX } from "./member-directory";

function catalog() {
  const db = requireDatabaseClient();
  return new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));
}

/** Succeeds when the Workspace the page URL names is one of the User's; NOT_FOUND otherwise. */
export const openWorkspace = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(() => null);

/**
 * The User's Workspaces and the one the page URL names (NOT_FOUND when it is not theirs). Opening a
 * Workspace also remembers it, so the bare app root (`/`) returns to it.
 */
export const loadWorkspaceSwitcher = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    const workspaces = await catalog().listForUser(user.id);
    const current = workspaces.find((workspace) => workspace.id === workspaceId)!;
    if (preferredWorkspaceSlugFromRequest() !== current.slug)
      writePreferredWorkspaceSlug(current.slug);
    return { workspaces, current };
  });

export const loadMemberDirectorySummary = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new WorkspaceMembers(db).summary(workspaceId, user.id);
  });

export type MemberDirectorySummary = Awaited<ReturnType<typeof loadMemberDirectorySummary>>;

const pageInput = {
  query: z.string().max(200).default(""),
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(MEMBER_PAGE_MAX),
};

export const loadMemberAgentPage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      ...pageInput,
      owner: z.enum(["all", "mine"]),
    }),
  )
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return new WorkspaceMembers(db).agentPage(workspaceId, user.id, data);
  });

export type MemberAgent = Awaited<ReturnType<typeof loadMemberAgentPage>>["items"][number];

export const loadMemberPeoplePage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object(pageInput))
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return new WorkspaceMembers(db).peoplePage(workspaceId, user.id, data);
  });

export type MemberPerson = Awaited<ReturnType<typeof loadMemberPeoplePage>>["items"][number];

/** Every human member and every visible Agent, for pickers; `viewerId` marks the viewer's own
 * entry among the people. */
export const loadWorkspaceDirectory = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    const directory = await new WorkspaceMembers(db).directory(workspaceId, user.id);
    return { viewerId: user.id, ...directory };
  });

export type WorkspaceDirectory = Awaited<ReturnType<typeof loadWorkspaceDirectory>>;

export const createWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(createWorkspaceInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const workspace = await catalog().createForUser(user.id, data);
    writePreferredWorkspaceSlug(workspace.slug);
    return workspace;
  });

/** Renames the Workspace the page URL names; its owner or an admin only. */
export const renameWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(renameWorkspaceInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) =>
    new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)).rename(
      workspaceId,
      await workspaceMemberRole(db, workspaceId, user.id),
      data.name,
    ),
  );

/** Replaces the icon of the Workspace the page URL names; its owner or an admin only. */
export const uploadWorkspaceIcon = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(workspaceIconUploadInput)
  .handler(async ({ data, context }) =>
    new WorkspaceImages(context.db).store(context.workspaceId, context.user.id, data.file),
  );

/**
 * Deletes the Workspace the page URL names for good; its owner only, confirming with its slug
 * (INVALID_INPUT otherwise). Answers which Workspace to open next, `null` when the owner is in no
 * other; `/` remembers that one from now on.
 */
export const deleteWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(deleteWorkspaceInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    await new WorkspaceDeletion(db, {
      files: getFileStorage,
      images: getPublicImageStorage,
      signals: centrifugoWorkspaceDeletionSignals(createCentrifugoServerApi),
    }).delete({ workspaceId, userId: user.id, confirmSlug: data.confirmSlug });
    return new WorkspaceDeparture(
      new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)),
      rememberedWorkspaceCookie,
    ).next(user.id);
  });
