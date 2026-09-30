import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  WorkspaceMemberDirectory,
  type WorkspaceMemberDirectoryStore,
  type WorkspaceMemberRecord,
} from "./member-directory.server";
import { isWorkspaceMemberRole, type WorkspaceMemberRole } from "./member-role.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import {
  ACTIVE_CHANNEL_MEMBER_WHERE,
  ACTIVE_MEMBER_WHERE,
} from "#src/server/conversations/active-member.server";

function asRole(value: string): WorkspaceMemberRole {
  if (!isWorkspaceMemberRole(value)) throw new AppError("INTERNAL_ERROR");
  return value;
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
        user: {
          select: { username: true, displayName: true, fullName: true, avatarObjectKey: true },
        },
      },
    });
    return rows.map((row) => ({
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: asRole(row.role),
      username: row.user.username,
      displayName: row.user.displayName,
      fullName: row.user.fullName,
      avatarUrl: workspaceUserAvatarUrl(workspaceId, row.userId, row.user.avatarObjectKey),
    }));
  }

  async updateRole(workspaceId: string, userId: string, role: WorkspaceMemberRole) {
    const row = await this.db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role },
      select: {
        workspaceId: true,
        userId: true,
        role: true,
        user: {
          select: { username: true, displayName: true, fullName: true, avatarObjectKey: true },
        },
      },
    });
    return {
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: asRole(row.role),
      username: row.user.username,
      displayName: row.user.displayName,
      fullName: row.user.fullName,
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
      // Soft-left, never deleted: their Messages and Tasks keep this row as sender, owner and
      // creator (`Restrict`), so their history stays readable under their name.
      await tx.conversationMember.updateMany({
        where: { workspaceId, userId, ...ACTIVE_MEMBER_WHERE },
        data: { leftAt: new Date() },
      });
      return { leftChannelIds: activeChannels.map((row) => row.conversationId) };
    });
  }
}

export function workspaceMemberDirectory(db: PrismaClient) {
  return new WorkspaceMemberDirectory(new PrismaWorkspaceMemberDirectoryStore(db));
}
