import { expect, test } from "bun:test";

import { AppError } from "../src/lib/app-error";
import {
  WorkspaceMemberDirectory,
  type WorkspaceMemberDirectoryStore,
  type WorkspaceInvitationRecord,
  type WorkspaceMemberRecord,
} from "../src/server/workspaces/member-directory.server";
import type { WorkspaceMemberRole } from "../src/server/workspaces/member-role.server";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const outsiderId = "44444444-4444-4444-8444-444444444444";

test("owner invites by username and invitee accepts into membership", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedUser(outsiderId, "grace");
  const directory = new WorkspaceMemberDirectory(store);

  const invitation = await directory.invite({
    workspaceId,
    actorUserId: ownerId,
    inviteeUsername: "grace",
    role: "member",
  });
  expect(invitation.role).toBe("member");
  expect(invitation.status).toBe("pending");
  expect(invitation.inviteeUserId).toBe(outsiderId);

  const accepted = await directory.acceptInvitation({
    invitationId: invitation.id,
    userId: outsiderId,
  });
  expect(accepted.role).toBe("member");
  expect(store.members.get(`${workspaceId}:${outsiderId}`)?.role).toBe("member");
  expect(store.generalEnrollments).toEqual([{ workspaceId, userId: outsiderId }]);
});

test("cannot invite as owner or invite an existing member", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "bob" });
  const directory = new WorkspaceMemberDirectory(store);

  await expect(
    directory.invite({
      workspaceId,
      actorUserId: ownerId,
      inviteeUsername: "bob",
      role: "member",
    }),
  ).rejects.toBeInstanceOf(AppError);

  await expect(
    directory.invite({
      workspaceId,
      actorUserId: ownerId,
      inviteeUsername: "bob",
      role: "owner",
    }),
  ).rejects.toBeInstanceOf(AppError);
});

test("admin can change member roles but not ownership", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: adminId, role: "admin", username: "admin" });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "bob" });
  const directory = new WorkspaceMemberDirectory(store);

  await directory.updateRole({
    workspaceId,
    actorUserId: adminId,
    targetUserId: memberId,
    role: "admin",
  });
  expect(store.members.get(`${workspaceId}:${memberId}`)?.role).toBe("admin");

  await expect(
    directory.updateRole({
      workspaceId,
      actorUserId: adminId,
      targetUserId: ownerId,
      role: "admin",
    }),
  ).rejects.toBeInstanceOf(AppError);
});

test("owner cannot leave; admin can leave and be removed", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: adminId, role: "admin", username: "admin" });
  const directory = new WorkspaceMemberDirectory(store);

  await expect(directory.leave({ workspaceId, userId: ownerId })).rejects.toBeInstanceOf(AppError);
  await directory.leave({ workspaceId, userId: adminId });
  expect(store.members.has(`${workspaceId}:${adminId}`)).toBe(false);

  store.seedMember({ workspaceId, userId: adminId, role: "admin", username: "admin" });
  await directory.removeMember({
    workspaceId,
    actorUserId: ownerId,
    targetUserId: adminId,
  });
  expect(store.members.has(`${workspaceId}:${adminId}`)).toBe(false);
});

test("ordinary members can list peers but cannot invite", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "bob" });
  const directory = new WorkspaceMemberDirectory(store);

  const listed = await directory.listMembers({ workspaceId, actorUserId: memberId });
  expect(listed.map((row) => row.username).sort()).toEqual(["ada", "bob"]);

  await expect(
    directory.invite({
      workspaceId,
      actorUserId: memberId,
      inviteeUsername: "grace",
      role: "member",
    }),
  ).rejects.toBeInstanceOf(AppError);
});

function memoryStore(): WorkspaceMemberDirectoryStore & {
  members: Map<string, WorkspaceMemberRecord>;
  invitations: Map<string, WorkspaceInvitationRecord>;
  users: Map<string, { id: string; username: string }>;
  generalEnrollments: { workspaceId: string; userId: string }[];
  seedMember(input: {
    workspaceId: string;
    userId: string;
    role: WorkspaceMemberRole;
    username: string;
  }): void;
  seedUser(userId: string, username: string): void;
} {
  const members = new Map<string, WorkspaceMemberRecord>();
  const invitations = new Map<string, WorkspaceInvitationRecord>();
  const users = new Map<string, { id: string; username: string }>();
  const generalEnrollments: { workspaceId: string; userId: string }[] = [];
  let invitationSeq = 0;

  return {
    members,
    invitations,
    users,
    generalEnrollments,
    seedMember(input) {
      users.set(input.userId, { id: input.userId, username: input.username });
      members.set(`${input.workspaceId}:${input.userId}`, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        username: input.username,
        displayName: null,
      });
    },
    seedUser(userId, username) {
      users.set(userId, { id: userId, username });
    },
    async findMembership(workspaceId, userId) {
      return members.get(`${workspaceId}:${userId}`) ?? null;
    },
    async listMembers(workspaceId) {
      return [...members.values()]
        .filter((row) => row.workspaceId === workspaceId)
        .sort((a, b) => a.username.localeCompare(b.username));
    },
    async findUserByUsername(username) {
      return [...users.values()].find((user) => user.username === username) ?? null;
    },
    async findPendingInvitation(workspaceId, inviteeUserId) {
      return (
        [...invitations.values()].find(
          (row) =>
            row.workspaceId === workspaceId &&
            row.inviteeUserId === inviteeUserId &&
            row.status === "pending",
        ) ?? null
      );
    },
    async createInvitation(input) {
      const id = `invitation-${++invitationSeq}`;
      const row: WorkspaceInvitationRecord = {
        id,
        workspaceId: input.workspaceId,
        inviterUserId: input.inviterUserId,
        inviteeUserId: input.inviteeUserId,
        inviteeUsername: input.inviteeUsername,
        role: input.role,
        status: "pending",
        expiresAt: input.expiresAt,
      };
      invitations.set(id, row);
      return row;
    },
    async getInvitation(invitationId) {
      return invitations.get(invitationId) ?? null;
    },
    async acceptInvitation(input) {
      const invitation = invitations.get(input.invitationId);
      if (!invitation) throw new AppError("NOT_FOUND");
      invitation.status = "accepted";
      const member: WorkspaceMemberRecord = {
        workspaceId: invitation.workspaceId,
        userId: input.userId,
        role: invitation.role,
        username: invitation.inviteeUsername,
        displayName: null,
      };
      members.set(`${member.workspaceId}:${member.userId}`, member);
      generalEnrollments.push({ workspaceId: member.workspaceId, userId: member.userId });
      return member;
    },
    async revokeInvitation(invitationId) {
      const invitation = invitations.get(invitationId);
      if (!invitation) throw new AppError("NOT_FOUND");
      invitation.status = "revoked";
      return invitation;
    },
    async listPendingInvitations(workspaceId) {
      return [...invitations.values()].filter(
        (row) => row.workspaceId === workspaceId && row.status === "pending",
      );
    },
    async updateRole(workspaceId, userId, role: WorkspaceMemberRole) {
      const key = `${workspaceId}:${userId}`;
      const member = members.get(key);
      if (!member) throw new AppError("NOT_FOUND");
      member.role = role;
      return member;
    },
    async removeMember(workspaceId, userId) {
      members.delete(`${workspaceId}:${userId}`);
    },
  };
}
