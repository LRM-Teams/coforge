import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "#src/lib/app-error";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { workspaceMemberDirectory } from "#src/server/workspaces/member-directory-store.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { WorkspaceDeparture } from "#src/server/workspaces/departure.server";
import { rememberedWorkspaceCookie } from "#src/server/workspaces/selection.server";

const updateRoleInputSchema = z.object({
  userId: z.uuid(),
  role: z.enum(["admin", "member"]),
});

const targetUserInputSchema = z.object({ userId: z.uuid() });

export const loadWorkspaceMembers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const members = workspaceMemberDirectory(db);
    const actor = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      select: { role: true },
    });
    if (!actor) throw new AppError("ACCESS_DENIED");
    const list = await members.listMembers({ workspaceId, actorUserId: user.id });
    return {
      workspaceId,
      actorUserId: user.id,
      actorRole: actor.role,
      members: list,
    };
  });

export const updateWorkspaceMemberRole = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateRoleInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return workspaceMemberDirectory(db).updateRole({
      workspaceId,
      actorUserId: user.id,
      targetUserId: data.userId,
      role: data.role,
    });
  });

export const removeWorkspaceMember = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(targetUserInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    await workspaceMemberDirectory(db).removeMember({
      workspaceId,
      actorUserId: user.id,
      targetUserId: data.userId,
    });
    return { ok: true as const };
  });

/**
 * Takes the caller out of the Workspace the page URL names (not its owner: CONFLICT) and answers
 * which Workspace to open next, `null` when they are in none; `/` remembers that one from now on.
 */
export const leaveWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) =>
    new WorkspaceDeparture(
      new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)),
      rememberedWorkspaceCookie,
    ).leave(workspaceMemberDirectory(db), { workspaceId, userId: user.id }),
  );
