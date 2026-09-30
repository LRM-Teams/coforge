import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import {
  WorkspaceMemberDirectory,
  type WorkspaceMemberDirectoryStore,
  type WorkspaceMemberRecord,
} from "#src/server/workspaces/member-directory.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";

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

test("leaving or being removed tells each of the person's channels that its member list changed", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({
    workspaceId,
    userId: adminId,
    role: "admin",
    username: "admin",
    channelIds: ["channel-1"],
  });
  store.seedMember({
    workspaceId,
    userId: memberId,
    role: "member",
    username: "bob",
    channelIds: ["channel-1", "channel-2"],
  });
  const announced: Array<{ workspaceId: string; conversationIds: readonly string[] }> = [];
  const directory = new WorkspaceMemberDirectory(store, {
    memberChanged: async (input) => {
      announced.push(input);
    },
  });

  await directory.leave({ workspaceId, userId: adminId });
  await directory.removeMember({ workspaceId, actorUserId: ownerId, targetUserId: memberId });

  expect(announced).toEqual([
    { workspaceId, conversationIds: ["channel-1"] },
    { workspaceId, conversationIds: ["channel-1", "channel-2"] },
  ]);
});

test("ordinary members can list peers", async () => {
  const store = memoryStore();
  store.seedMember({ workspaceId, userId: ownerId, role: "owner", username: "ada" });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "bob" });
  const directory = new WorkspaceMemberDirectory(store);

  const listed = await directory.listMembers({ workspaceId, actorUserId: memberId });
  expect(listed.map((row) => row.username).sort()).toEqual(["ada", "bob"]);
});

test("members are listed in the order of the names they are shown by, not of their usernames", async () => {
  const store = memoryStore();
  store.seedMember({
    workspaceId,
    userId: ownerId,
    role: "owner",
    username: "ada",
    displayName: "Zoe",
  });
  store.seedMember({
    workspaceId,
    userId: adminId,
    role: "admin",
    username: "zed",
    displayName: "Alice",
  });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "mia" });
  const directory = new WorkspaceMemberDirectory(store);

  const listed = await directory.listMembers({ workspaceId, actorUserId: ownerId });
  expect(listed.map((row) => row.username)).toEqual(["zed", "mia", "ada"]);
});

test("a member with only a full name is listed by it, between a nickname and a bare username", async () => {
  const store = memoryStore();
  store.seedMember({
    workspaceId,
    userId: ownerId,
    role: "owner",
    username: "ada",
    fullName: "Zoe Zed",
  });
  store.seedMember({
    workspaceId,
    userId: adminId,
    role: "admin",
    username: "zed",
    displayName: "Alice",
    fullName: "Zed Person",
  });
  store.seedMember({ workspaceId, userId: memberId, role: "member", username: "mia" });
  const directory = new WorkspaceMemberDirectory(store);

  const listed = await directory.listMembers({ workspaceId, actorUserId: ownerId });
  expect(listed.map(humanLabel)).toEqual(["Alice", "mia", "Zoe Zed"]);
});

function memoryStore(): WorkspaceMemberDirectoryStore & {
  members: Map<string, WorkspaceMemberRecord>;
  /** The channels each `${workspaceId}:${userId}` member is active in. */
  channels: Map<string, string[]>;
  seedMember(input: {
    workspaceId: string;
    userId: string;
    role: WorkspaceMemberRole;
    username: string;
    displayName?: string;
    fullName?: string;
    channelIds?: string[];
  }): void;
} {
  const members = new Map<string, WorkspaceMemberRecord>();
  const channels = new Map<string, string[]>();

  return {
    members,
    channels,
    seedMember(input) {
      channels.set(`${input.workspaceId}:${input.userId}`, input.channelIds ?? []);
      members.set(`${input.workspaceId}:${input.userId}`, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        username: input.username,
        displayName: input.displayName ?? null,
        fullName: input.fullName ?? null,
        avatarUrl: null,
      });
    },
    async findMembership(workspaceId, userId) {
      return members.get(`${workspaceId}:${userId}`) ?? null;
    },
    async listMembers(workspaceId) {
      return [...members.values()]
        .filter((row) => row.workspaceId === workspaceId)
        .sort((a, b) => a.username.localeCompare(b.username));
    },
    async updateRole(workspaceId, userId, role: WorkspaceMemberRole) {
      const key = `${workspaceId}:${userId}`;
      const member = members.get(key);
      if (!member) throw new AppError("NOT_FOUND");
      member.role = role;
      return member;
    },
    async removeMember(workspaceId, userId) {
      const key = `${workspaceId}:${userId}`;
      members.delete(key);
      const leftChannelIds = channels.get(key) ?? [];
      channels.delete(key);
      return { leftChannelIds };
    },
  };
}
