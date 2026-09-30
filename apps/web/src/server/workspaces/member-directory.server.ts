import { AppError } from "#src/lib/app-error";
import { compareHumanLabels } from "#src/lib/human-label";
import {
  assertCanChangeMemberRole,
  assertCanLeaveWorkspace,
  assertCanRemoveMember,
  type WorkspaceMemberRole,
} from "./member-role.server";
import {
  announceMemberChanged,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";

export type WorkspaceMemberRecord = {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  username: string;
  displayName: string | null;
  fullName: string | null;
  /** Where the browser reads this member's avatar; null when they have not uploaded one. */
  avatarUrl: string | null;
};

export type WorkspaceMemberDirectoryStore = {
  findMembership(
    workspaceId: string,
    userId: string,
  ): Promise<Pick<WorkspaceMemberRecord, "workspaceId" | "userId" | "role"> | null>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>;
  updateRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberRecord>;
  /** Removes the person from the Workspace and leaves every conversation in it for them (their
   * rows stay, so what they wrote keeps its sender); reports the channels they were an active
   * member of, whose member lists now changed. */
  removeMember(workspaceId: string, userId: string): Promise<{ leftChannelIds: string[] }>;
};

/** Human Workspace membership directory: list, role changes, remove, leave. */
export class WorkspaceMemberDirectory {
  constructor(
    private readonly store: WorkspaceMemberDirectoryStore,
    private readonly realtime?: Pick<ConversationRealtime, "memberChanged">,
  ) {}

  async listMembers(input: { workspaceId: string; actorUserId: string }) {
    await this.requireMembership(input.workspaceId, input.actorUserId);
    const members = await this.store.listMembers(input.workspaceId);
    // By the name they are shown by; the store's order is not part of its contract.
    return [...members].sort(compareHumanLabels);
  }

  async updateRole(input: {
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    role: string;
  }) {
    const actor = await this.requireMembership(input.workspaceId, input.actorUserId);
    const target = await this.store.findMembership(input.workspaceId, input.targetUserId);
    if (!target) throw new AppError("NOT_FOUND");
    const nextRole = assertCanChangeMemberRole(actor.role, target.role, input.role);
    return this.store.updateRole(input.workspaceId, input.targetUserId, nextRole);
  }

  async removeMember(input: { workspaceId: string; actorUserId: string; targetUserId: string }) {
    const actor = await this.requireMembership(input.workspaceId, input.actorUserId);
    const target = await this.store.findMembership(input.workspaceId, input.targetUserId);
    if (!target) throw new AppError("NOT_FOUND");
    assertCanRemoveMember(actor.role, target.role);
    await this.removeFromWorkspace(input.workspaceId, input.targetUserId);
  }

  async leave(input: { workspaceId: string; userId: string }) {
    const membership = await this.requireMembership(input.workspaceId, input.userId);
    assertCanLeaveWorkspace(membership.role);
    await this.removeFromWorkspace(input.workspaceId, input.userId);
  }

  /** Removes the person, then tells the channels they were in that their member lists changed. */
  private async removeFromWorkspace(workspaceId: string, userId: string) {
    const { leftChannelIds } = await this.store.removeMember(workspaceId, userId);
    await announceMemberChanged(this.realtime, { workspaceId, conversationIds: leftChannelIds });
  }

  private async requireMembership(workspaceId: string, userId: string) {
    const membership = await this.store.findMembership(workspaceId, userId);
    if (!membership) throw new AppError("ACCESS_DENIED");
    return membership;
  }
}
