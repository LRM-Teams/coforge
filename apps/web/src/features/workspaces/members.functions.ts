import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import { authMiddleware } from "../../server/auth/function-auth";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireExistingWorkspaceId } from "../../server/workspaces/enrollment.server";
import { workspaceMemberDirectory } from "../../server/workspaces/member-directory-store.server";
import { preferredWorkspaceSlugFromRequest } from "../../server/workspaces/selection.server";
import { INVITABLE_WORKSPACE_ROLES } from "../../server/workspaces/member-role.server";

function directory() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return { db, directory: workspaceMemberDirectory(db) };
}

async function currentWorkspaceId(userId: string) {
  const { db } = directory();
  return requireExistingWorkspaceId(db, userId, preferredWorkspaceSlugFromRequest());
}

const inviteInputSchema = z.object({
  username: z.string().trim().min(1),
  role: z.enum(INVITABLE_WORKSPACE_ROLES),
});

const updateRoleInputSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "member"]),
});

const targetUserInputSchema = z.object({ userId: z.string().uuid() });
const invitationIdInputSchema = z.object({ invitationId: z.string().uuid() });

export const loadWorkspaceMembers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const { db, directory: members } = directory();
    const workspaceId = await requireExistingWorkspaceId(
      db,
      user.id,
      preferredWorkspaceSlugFromRequest(),
    );
    const actor = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      select: { role: true },
    });
    if (!actor) throw new AppError("ACCESS_DENIED");
    const list = await members.listMembers({ workspaceId, actorUserId: user.id });
    const pendingInvitations =
      actor.role === "owner" || actor.role === "admin"
        ? await members.listPendingInvitations({ workspaceId, actorUserId: user.id })
        : [];
    return {
      workspaceId,
      actorUserId: user.id,
      actorRole: actor.role,
      members: list,
      pendingInvitations,
    };
  });

export const inviteWorkspaceMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(inviteInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const workspaceId = await currentWorkspaceId(user.id);
    return directory().directory.invite({
      workspaceId,
      actorUserId: user.id,
      inviteeUsername: data.username,
      role: data.role,
    });
  });

export const acceptWorkspaceInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(invitationIdInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    return directory().directory.acceptInvitation({
      invitationId: data.invitationId,
      userId: user.id,
    });
  });

export const declineWorkspaceInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(invitationIdInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    return directory().directory.declineInvitation({
      invitationId: data.invitationId,
      userId: user.id,
    });
  });

export const revokeWorkspaceInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(invitationIdInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const workspaceId = await currentWorkspaceId(user.id);
    return directory().directory.revokeInvitation({
      workspaceId,
      actorUserId: user.id,
      invitationId: data.invitationId,
    });
  });

export const updateWorkspaceMemberRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(updateRoleInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const workspaceId = await currentWorkspaceId(user.id);
    return directory().directory.updateRole({
      workspaceId,
      actorUserId: user.id,
      targetUserId: data.userId,
      role: data.role,
    });
  });

export const removeWorkspaceMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(targetUserInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const workspaceId = await currentWorkspaceId(user.id);
    await directory().directory.removeMember({
      workspaceId,
      actorUserId: user.id,
      targetUserId: data.userId,
    });
    return { ok: true as const };
  });

export const leaveWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const workspaceId = await currentWorkspaceId(user.id);
    await directory().directory.leave({ workspaceId, userId: user.id });
    return { ok: true as const };
  });

export const loadMyWorkspaceInvitations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const { db } = directory();
    const rows = await db.workspaceInvitation.findMany({
      where: {
        inviteeUserId: user.id,
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        role: true,
        expiresAt: true,
        workspace: { select: { id: true, slug: true, name: true } },
        inviter: { select: { username: true, displayName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
      workspace: row.workspace,
      inviterUsername: row.inviter.username,
      inviterDisplayName: row.inviter.displayName,
    }));
  });
