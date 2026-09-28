import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "#src/lib/app-error";
import { authMiddleware, workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { workspaceMemberDirectory } from "#src/server/workspaces/member-directory-store.server";
import { INVITABLE_WORKSPACE_ROLES } from "#src/server/workspaces/member-role.server";

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
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const members = workspaceMemberDirectory(db);
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
  .middleware([workspaceUserMiddleware])
  .validator(inviteInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return workspaceMemberDirectory(db).invite({
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
    return workspaceMemberDirectory(requireDatabaseClient()).acceptInvitation({
      invitationId: data.invitationId,
      userId: user.id,
    });
  });

export const declineWorkspaceInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(invitationIdInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    return workspaceMemberDirectory(requireDatabaseClient()).declineInvitation({
      invitationId: data.invitationId,
      userId: user.id,
    });
  });

export const revokeWorkspaceInvitation = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(invitationIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return workspaceMemberDirectory(db).revokeInvitation({
      workspaceId,
      actorUserId: user.id,
      invitationId: data.invitationId,
    });
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

export const leaveWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    await workspaceMemberDirectory(db).leave({ workspaceId, userId: user.id });
    return { ok: true as const };
  });

export const loadMyWorkspaceInvitations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const db = requireDatabaseClient();
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
