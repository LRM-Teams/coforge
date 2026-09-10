import { AppError } from "../../lib/app-error";
import {
  assertCanChangeMemberRole,
  assertCanInvite,
  assertCanLeaveWorkspace,
  assertCanManageMembers,
  assertCanRemoveMember,
  type InvitableWorkspaceRole,
  type WorkspaceMemberRole,
} from "./member-role.server";

export type WorkspaceMemberRecord = {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  username: string;
  displayName: string | null;
};

export type WorkspaceInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export type WorkspaceInvitationRecord = {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  inviteeUserId: string;
  inviteeUsername: string;
  role: InvitableWorkspaceRole;
  status: WorkspaceInvitationStatus;
  expiresAt: Date;
};

export type WorkspaceMemberDirectoryStore = {
  findMembership(
    workspaceId: string,
    userId: string,
  ): Promise<Pick<WorkspaceMemberRecord, "workspaceId" | "userId" | "role"> | null>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>;
  findUserByUsername(username: string): Promise<{ id: string; username: string } | null>;
  findPendingInvitation(
    workspaceId: string,
    inviteeUserId: string,
  ): Promise<WorkspaceInvitationRecord | null>;
  createInvitation(input: {
    workspaceId: string;
    inviterUserId: string;
    inviteeUserId: string;
    inviteeUsername: string;
    role: InvitableWorkspaceRole;
    expiresAt: Date;
  }): Promise<WorkspaceInvitationRecord>;
  getInvitation(invitationId: string): Promise<WorkspaceInvitationRecord | null>;
  acceptInvitation(input: { invitationId: string; userId: string }): Promise<WorkspaceMemberRecord>;
  revokeInvitation(invitationId: string): Promise<WorkspaceInvitationRecord>;
  listPendingInvitations(workspaceId: string): Promise<WorkspaceInvitationRecord[]>;
  updateRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberRecord>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
};

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Human Workspace membership directory: list, invite, accept, role changes, remove, leave. */
export class WorkspaceMemberDirectory {
  constructor(
    private readonly store: WorkspaceMemberDirectoryStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listMembers(input: { workspaceId: string; actorUserId: string }) {
    await this.requireMembership(input.workspaceId, input.actorUserId);
    return this.store.listMembers(input.workspaceId);
  }

  async listPendingInvitations(input: { workspaceId: string; actorUserId: string }) {
    const actor = await this.requireMembership(input.workspaceId, input.actorUserId);
    assertCanManageMembers(actor.role);
    return this.store.listPendingInvitations(input.workspaceId);
  }

  async invite(input: {
    workspaceId: string;
    actorUserId: string;
    inviteeUsername: string;
    role: string;
  }) {
    const actor = await this.requireMembership(input.workspaceId, input.actorUserId);
    const role = assertCanInvite(actor.role, input.role);
    const username = input.inviteeUsername.trim().replace(/^@/, "");
    if (!username) throw new AppError("INVALID_INPUT");
    const invitee = await this.store.findUserByUsername(username);
    if (!invitee) throw new AppError("NOT_FOUND");
    if (invitee.id === input.actorUserId) throw new AppError("INVALID_INPUT");
    const existing = await this.store.findMembership(input.workspaceId, invitee.id);
    if (existing) throw new AppError("CONFLICT");
    const pending = await this.store.findPendingInvitation(input.workspaceId, invitee.id);
    if (pending && pending.expiresAt > this.now()) throw new AppError("CONFLICT");
    return this.store.createInvitation({
      workspaceId: input.workspaceId,
      inviterUserId: input.actorUserId,
      inviteeUserId: invitee.id,
      inviteeUsername: invitee.username,
      role,
      expiresAt: new Date(this.now().getTime() + INVITATION_TTL_MS),
    });
  }

  async acceptInvitation(input: { invitationId: string; userId: string }) {
    const invitation = await this.store.getInvitation(input.invitationId);
    if (!invitation) throw new AppError("NOT_FOUND");
    if (invitation.inviteeUserId !== input.userId) throw new AppError("ACCESS_DENIED");
    if (invitation.status !== "pending") throw new AppError("CONFLICT");
    if (invitation.expiresAt <= this.now()) throw new AppError("CONFLICT");
    const existing = await this.store.findMembership(invitation.workspaceId, input.userId);
    if (existing) throw new AppError("CONFLICT");
    return this.store.acceptInvitation(input);
  }

  /** The invitee turning down their own pending invitation (no workspace membership required). */
  async declineInvitation(input: { invitationId: string; userId: string }) {
    const invitation = await this.store.getInvitation(input.invitationId);
    if (!invitation) throw new AppError("NOT_FOUND");
    if (invitation.inviteeUserId !== input.userId) throw new AppError("ACCESS_DENIED");
    if (invitation.status !== "pending") throw new AppError("CONFLICT");
    return this.store.revokeInvitation(input.invitationId);
  }

  async revokeInvitation(input: {
    workspaceId: string;
    actorUserId: string;
    invitationId: string;
  }) {
    const actor = await this.requireMembership(input.workspaceId, input.actorUserId);
    assertCanManageMembers(actor.role);
    const invitation = await this.store.getInvitation(input.invitationId);
    if (!invitation || invitation.workspaceId !== input.workspaceId) {
      throw new AppError("NOT_FOUND");
    }
    if (invitation.status !== "pending") throw new AppError("CONFLICT");
    return this.store.revokeInvitation(input.invitationId);
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
    await this.store.removeMember(input.workspaceId, input.targetUserId);
  }

  async leave(input: { workspaceId: string; userId: string }) {
    const membership = await this.requireMembership(input.workspaceId, input.userId);
    assertCanLeaveWorkspace(membership.role);
    await this.store.removeMember(input.workspaceId, input.userId);
  }

  private async requireMembership(workspaceId: string, userId: string) {
    const membership = await this.store.findMembership(workspaceId, userId);
    if (!membership) throw new AppError("ACCESS_DENIED");
    return membership;
  }
}
