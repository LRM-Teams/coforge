import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { enrollGeneralChannel } from "#src/server/conversations/public-channels.server";
import {
  WorkspaceMemberDirectory,
  type WorkspaceInvitationRecord,
  type WorkspaceMemberDirectoryStore,
  type WorkspaceMemberRecord,
} from "./member-directory.server";
import {
  isWorkspaceMemberRole,
  type InvitableWorkspaceRole,
  type WorkspaceMemberRole,
} from "./member-role.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ACTIVE_CHANNEL_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

function asRole(value: string): WorkspaceMemberRole {
  if (!isWorkspaceMemberRole(value)) throw new AppError("INTERNAL_ERROR");
  return value;
}

function asInvitableRole(value: string): InvitableWorkspaceRole {
  if (value === "admin" || value === "member") return value;
  throw new AppError("INTERNAL_ERROR");
}

function mapInvitation(row: {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  inviteeUserId: string;
  role: string;
  status: string;
  expiresAt: Date;
  invitee: { username: string };
}): WorkspaceInvitationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    inviterUserId: row.inviterUserId,
    inviteeUserId: row.inviteeUserId,
    inviteeUsername: row.invitee.username,
    role: asInvitableRole(row.role),
    status: row.status as WorkspaceInvitationRecord["status"],
    expiresAt: row.expiresAt,
  };
}

export class PrismaWorkspaceMemberDirectoryStore implements WorkspaceMemberDirectoryStore {
  constructor(private readonly db: PrismaClient) {}

  async findMembership(workspaceId: string, userId: string) {
    const row = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { workspaceId: true, userId: true, role: true },
    });
    if (!row) return null;
    return { ...row, role: asRole(row.role) };
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    const rows = await this.db.workspaceMembership.findMany({
      where: { workspaceId },
      select: {
        workspaceId: true,
        userId: true,
        role: true,
        user: { select: { username: true, displayName: true, avatarObjectKey: true } },
      },
      orderBy: { user: { username: "asc" } },
    });
    return rows.map((row) => ({
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: asRole(row.role),
      username: row.user.username,
      displayName: row.user.displayName,
      avatarUrl: workspaceUserAvatarUrl(workspaceId, row.userId, row.user.avatarObjectKey),
    }));
  }

  async findUserByUsername(username: string) {
    return this.db.user.findUnique({
      where: { username },
      select: { id: true, username: true },
    });
  }

  async findPendingInvitation(workspaceId: string, inviteeUserId: string) {
    const row = await this.db.workspaceInvitation.findFirst({
      where: { workspaceId, inviteeUserId, status: "pending" },
      include: { invitee: { select: { username: true } } },
    });
    return row ? mapInvitation(row) : null;
  }

  async createInvitation(input: {
    workspaceId: string;
    inviterUserId: string;
    inviteeUserId: string;
    inviteeUsername: string;
    role: InvitableWorkspaceRole;
    expiresAt: Date;
  }) {
    // Drop expired pending rows so the partial unique index cannot block a retry.
    await this.db.workspaceInvitation.updateMany({
      where: {
        workspaceId: input.workspaceId,
        inviteeUserId: input.inviteeUserId,
        status: "pending",
        expiresAt: { lte: new Date() },
      },
      data: { status: "expired" },
    });
    try {
      const row = await this.db.workspaceInvitation.create({
        data: {
          workspaceId: input.workspaceId,
          inviterUserId: input.inviterUserId,
          inviteeUserId: input.inviteeUserId,
          role: input.role,
          status: "pending",
          expiresAt: input.expiresAt,
        },
        include: { invitee: { select: { username: true } } },
      });
      return mapInvitation(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("CONFLICT");
      throw error;
    }
  }

  async getInvitation(invitationId: string) {
    const row = await this.db.workspaceInvitation.findUnique({
      where: { id: invitationId },
      include: { invitee: { select: { username: true } } },
    });
    return row ? mapInvitation(row) : null;
  }

  async acceptInvitation(input: { invitationId: string; userId: string }) {
    return this.db.$transaction(async (tx) => {
      const invitation = await tx.workspaceInvitation.findUnique({
        where: { id: input.invitationId },
        include: {
          invitee: { select: { username: true, displayName: true, avatarObjectKey: true } },
        },
      });
      if (!invitation) throw new AppError("NOT_FOUND");
      const updated = await tx.workspaceInvitation.updateMany({
        where: { id: input.invitationId, status: "pending" },
        data: { status: "accepted" },
      });
      if (updated.count !== 1) throw new AppError("CONFLICT");
      await tx.workspaceMembership.create({
        data: {
          workspaceId: invitation.workspaceId,
          userId: input.userId,
          role: invitation.role,
        },
      });
      await enrollGeneralChannel(tx, invitation.workspaceId);
      return {
        workspaceId: invitation.workspaceId,
        userId: input.userId,
        role: asInvitableRole(invitation.role),
        username: invitation.invitee.username,
        displayName: invitation.invitee.displayName,
        avatarUrl: workspaceUserAvatarUrl(
          invitation.workspaceId,
          input.userId,
          invitation.invitee.avatarObjectKey,
        ),
      };
    });
  }

  async revokeInvitation(invitationId: string) {
    const row = await this.db.workspaceInvitation.update({
      where: { id: invitationId },
      data: { status: "revoked" },
      include: { invitee: { select: { username: true } } },
    });
    return mapInvitation(row);
  }

  async listPendingInvitations(workspaceId: string) {
    const rows = await this.db.workspaceInvitation.findMany({
      where: { workspaceId, status: "pending", expiresAt: { gt: new Date() } },
      include: { invitee: { select: { username: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapInvitation);
  }

  async updateRole(workspaceId: string, userId: string, role: WorkspaceMemberRole) {
    const row = await this.db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role },
      select: {
        workspaceId: true,
        userId: true,
        role: true,
        user: { select: { username: true, displayName: true, avatarObjectKey: true } },
      },
    });
    return {
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: asRole(row.role),
      username: row.user.username,
      displayName: row.user.displayName,
      avatarUrl: workspaceUserAvatarUrl(workspaceId, row.userId, row.user.avatarObjectKey),
    };
  }

  async removeMember(workspaceId: string, userId: string) {
    return this.db.$transaction(async (tx) => {
      await tx.workspaceMembership.delete({
        where: { workspaceId_userId: { workspaceId, userId } },
      });
      const activeChannels = await tx.conversationMember.findMany({
        where: { workspaceId, userId, ...ACTIVE_CHANNEL_MEMBER_WHERE },
        select: { conversationId: true },
      });
      await tx.conversationMember.deleteMany({
        where: { workspaceId, userId },
      });
      return { leftChannelIds: activeChannels.map((row) => row.conversationId) };
    });
  }
}

export function workspaceMemberDirectory(db: PrismaClient) {
  return new WorkspaceMemberDirectory(new PrismaWorkspaceMemberDirectoryStore(db));
}
