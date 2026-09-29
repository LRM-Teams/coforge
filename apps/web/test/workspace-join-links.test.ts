import { expect, test } from "bun:test";

import {
  isJoinLinkActive,
  WorkspaceJoinLinks,
  type JoinLinkWorkspace,
  type WorkspaceJoinLinkRecord,
  type WorkspaceJoinLinkStore,
} from "#src/server/workspaces/join-links.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const visitorId = "44444444-4444-4444-8444-444444444444";
const secondVisitorId = "55555555-5555-4555-8555-555555555555";
const GENERAL_CHANNEL_ID = "general-channel";
const NOW = new Date("2026-09-29T08:00:00.000Z");
const IN_A_DAY = new Date("2026-09-30T08:00:00.000Z");

function setup() {
  const store = memoryStore();
  store.roles.set(`${workspaceId}:${ownerId}`, "owner");
  store.roles.set(`${workspaceId}:${adminId}`, "admin");
  store.roles.set(`${workspaceId}:${memberId}`, "member");
  let now = NOW;
  const announced: Array<{ workspaceId: string; conversationIds: readonly string[] }> = [];
  const links = new WorkspaceJoinLinks(store, () => now, {
    memberChanged: async (input) => {
      announced.push(input);
    },
  });
  return {
    store,
    links,
    announced,
    advanceTo(next: Date) {
      now = next;
    },
  };
}

test("an owner or admin creates a link, and it is the Workspace's current link", async () => {
  const { links } = setup();
  expect(await links.current({ workspaceId, actorUserId: ownerId })).toBeNull();

  const created = await links.create({
    workspaceId,
    actorUserId: adminId,
    maxUses: 5,
    expiresAt: IN_A_DAY,
  });

  expect(created).toMatchObject({ maxUses: 5, useCount: 0, expiresAt: IN_A_DAY });
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await links.current({ workspaceId, actorUserId: ownerId })).toEqual(created);
});

test("creating a link retires the one before it, so no working link is ever hidden", async () => {
  const { links } = setup();
  const first = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: null,
    expiresAt: null,
  });

  const second = await links.create({
    workspaceId,
    actorUserId: adminId,
    maxUses: null,
    expiresAt: null,
  });

  expect(await links.current({ workspaceId, actorUserId: ownerId })).toEqual(second);
  const notFound = { code: "NOT_FOUND" };
  await expect(links.inspect({ token: first.token })).rejects.toMatchObject(notFound);
  await expect(links.join({ token: first.token, userId: visitorId })).rejects.toMatchObject(
    notFound,
  );
});

test("an ordinary member cannot see or manage the Workspace's links", async () => {
  const { links } = setup();
  const link = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: null,
    expiresAt: null,
  });
  const denied = { code: "ACCESS_DENIED" };

  await expect(links.current({ workspaceId, actorUserId: memberId })).rejects.toMatchObject(denied);
  await expect(
    links.create({ workspaceId, actorUserId: memberId, maxUses: null, expiresAt: null }),
  ).rejects.toMatchObject(denied);
  await expect(
    links.replace({
      workspaceId,
      actorUserId: memberId,
      linkId: link.id,
      maxUses: null,
      expiresAt: null,
    }),
  ).rejects.toMatchObject(denied);
  await expect(
    links.revoke({ workspaceId, actorUserId: memberId, linkId: link.id }),
  ).rejects.toMatchObject(denied);
  await expect(links.current({ workspaceId, actorUserId: visitorId })).rejects.toMatchObject(
    denied,
  );
});

test("a link's use limit is a positive whole number and its expiry lies ahead", async () => {
  const { links } = setup();
  for (const options of [
    { maxUses: 0, expiresAt: null },
    { maxUses: -3, expiresAt: null },
    { maxUses: 1.5, expiresAt: null },
    { maxUses: 2_147_483_648, expiresAt: null },
    { maxUses: null, expiresAt: NOW },
    { maxUses: null, expiresAt: new Date("2026-09-28T08:00:00.000Z") },
    { maxUses: null, expiresAt: new Date(Number.NaN) },
  ]) {
    await expect(
      links.create({ workspaceId, actorUserId: ownerId, ...options }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
});

test("updating a link replaces it: the old URL stops working and the new one opens", async () => {
  const { links } = setup();
  const old = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: null,
    expiresAt: null,
  });

  const replacement = await links.replace({
    workspaceId,
    actorUserId: adminId,
    linkId: old.id,
    maxUses: 10,
    expiresAt: IN_A_DAY,
  });

  expect(replacement.id).not.toBe(old.id);
  expect(replacement.token).not.toBe(old.token);
  expect(replacement).toMatchObject({ maxUses: 10, useCount: 0, expiresAt: IN_A_DAY });
  expect(await links.current({ workspaceId, actorUserId: ownerId })).toEqual(replacement);
  await expect(links.inspect({ token: old.token })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await links.inspect({ token: replacement.token })).workspace.slug).toBe("acme");
  // A replaced link cannot be replaced again.
  await expect(
    links.replace({
      workspaceId,
      actorUserId: ownerId,
      linkId: old.id,
      maxUses: null,
      expiresAt: null,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a revoked link is no longer current and no longer admits anyone", async () => {
  const { links } = setup();
  const link = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: null,
    expiresAt: null,
  });

  await links.revoke({ workspaceId, actorUserId: adminId, linkId: link.id });

  expect(await links.current({ workspaceId, actorUserId: ownerId })).toBeNull();
  await expect(links.join({ token: link.token, userId: visitorId })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    links.revoke({ workspaceId, actorUserId: ownerId, linkId: link.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a link of another Workspace cannot be managed from this one", async () => {
  const { links, store } = setup();
  const otherWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  store.roles.set(`${otherWorkspaceId}:${visitorId}`, "owner");
  const foreign = await links.create({
    workspaceId: otherWorkspaceId,
    actorUserId: visitorId,
    maxUses: null,
    expiresAt: null,
  });

  await expect(
    links.revoke({ workspaceId, actorUserId: ownerId, linkId: foreign.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    links.replace({
      workspaceId,
      actorUserId: ownerId,
      linkId: foreign.id,
      maxUses: null,
      expiresAt: null,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a visitor previews the Workspace a link opens: its name, people and Agents", async () => {
  const { links } = setup();
  const link = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: null,
    expiresAt: null,
  });

  expect(await links.inspect({ token: link.token })).toEqual({
    workspace: { slug: "acme", name: "Acme", iconUrl: null },
    memberCount: 3,
    agentCount: 2,
    viewerIsMember: false,
  });
  expect((await links.inspect({ token: link.token, viewerUserId: memberId })).viewerIsMember).toBe(
    true,
  );
});

test("an unknown, revoked, expired or used-up link all read as not found", async () => {
  const { links, advanceTo } = setup();
  const notFound = { code: "NOT_FOUND" };
  await expect(links.inspect({ token: "no-such-token" })).rejects.toMatchObject(notFound);

  const revoked = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: null,
    expiresAt: null,
  });
  await links.revoke({ workspaceId, actorUserId: ownerId, linkId: revoked.id });
  await expect(links.inspect({ token: revoked.token })).rejects.toMatchObject(notFound);

  const usedUp = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: 1,
    expiresAt: null,
  });
  await links.join({ token: usedUp.token, userId: visitorId });
  await expect(links.inspect({ token: usedUp.token })).rejects.toMatchObject(notFound);

  const expiring = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: null,
    expiresAt: IN_A_DAY,
  });
  advanceTo(IN_A_DAY);
  await expect(links.inspect({ token: expiring.token })).rejects.toMatchObject(notFound);
  await expect(
    links.join({ token: expiring.token, userId: secondVisitorId }),
  ).rejects.toMatchObject(notFound);
  expect(await links.current({ workspaceId, actorUserId: ownerId })).toBeNull();
});

test("joining by a link admits the visitor as a member, counts one use and tells #general", async () => {
  const { links, store, announced } = setup();
  const link = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: 2,
    expiresAt: null,
  });

  expect(await links.join({ token: link.token, userId: visitorId })).toEqual({
    workspaceId,
    slug: store.workspace.slug,
  });

  expect(store.roles.get(`${workspaceId}:${visitorId}`)).toBe("member");
  expect((await links.current({ workspaceId, actorUserId: ownerId }))?.useCount).toBe(1);
  expect(announced).toEqual([{ workspaceId, conversationIds: [GENERAL_CHANNEL_ID] }]);
});

test("a member opening the link again lands in the Workspace without using it up", async () => {
  const { links, store, announced } = setup();
  const link = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: 1,
    expiresAt: null,
  });

  expect(await links.join({ token: link.token, userId: memberId })).toEqual({
    workspaceId,
    slug: store.workspace.slug,
  });

  expect(store.roles.get(`${workspaceId}:${memberId}`)).toBe("member");
  expect((await links.current({ workspaceId, actorUserId: ownerId }))?.useCount).toBe(0);
  expect(announced).toEqual([]);
});

test("once a link reaches its use limit nobody else joins by it", async () => {
  const { links, store } = setup();
  const link = await links.create({
    workspaceId,
    actorUserId: ownerId,
    maxUses: 1,
    expiresAt: null,
  });
  await links.join({ token: link.token, userId: visitorId });

  await expect(links.join({ token: link.token, userId: secondVisitorId })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(store.roles.has(`${workspaceId}:${secondVisitorId}`)).toBe(false);
});

test("a link is active until it is revoked, expires or is used up", () => {
  const link = {
    maxUses: 2,
    useCount: 1,
    expiresAt: IN_A_DAY,
    revokedAt: null,
  };
  expect(isJoinLinkActive(link, NOW)).toBe(true);
  expect(isJoinLinkActive({ ...link, maxUses: null, expiresAt: null }, NOW)).toBe(true);
  expect(isJoinLinkActive({ ...link, useCount: 2 }, NOW)).toBe(false);
  expect(isJoinLinkActive(link, IN_A_DAY)).toBe(false);
  expect(isJoinLinkActive({ ...link, revokedAt: NOW }, NOW)).toBe(false);
});

/** An in-memory store; the Workspace has three people and two public, live Agents. */
function memoryStore(): WorkspaceJoinLinkStore & {
  roles: Map<string, WorkspaceMemberRole>;
  links: Map<string, WorkspaceJoinLinkRecord>;
  workspace: JoinLinkWorkspace;
} {
  const roles = new Map<string, WorkspaceMemberRole>();
  const links = new Map<string, WorkspaceJoinLinkRecord>();
  const workspace: JoinLinkWorkspace = {
    id: workspaceId,
    slug: "acme",
    name: "Acme",
    iconUrl: null,
  };
  let sequence = 0;

  const insert = (input: Parameters<WorkspaceJoinLinkStore["create"]>[0]) => {
    sequence += 1;
    const row: WorkspaceJoinLinkRecord = {
      id: `link-${sequence}`,
      workspaceId: input.workspaceId,
      token: input.token,
      maxUses: input.maxUses,
      useCount: 0,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: new Date(NOW.getTime() + sequence),
    };
    links.set(row.id, row);
    return { ...row };
  };
  const revoke = (workspaceId: string, linkId: string, now: Date) => {
    const row = links.get(linkId);
    if (!row || row.workspaceId !== workspaceId || row.revokedAt) return false;
    row.revokedAt = now;
    return true;
  };

  return {
    roles,
    links,
    workspace,
    async findMemberRole(workspaceId, userId) {
      return roles.get(`${workspaceId}:${userId}`) ?? null;
    },
    async findLatestActive(workspaceId, now) {
      const row = [...links.values()]
        .filter((link) => link.workspaceId === workspaceId && isJoinLinkActive(link, now))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return row ? { ...row } : null;
    },
    async create(input) {
      for (const link of links.values())
        if (link.workspaceId === input.workspaceId && !link.revokedAt) link.revokedAt = input.now;
      return insert(input);
    },
    async replace(input) {
      if (!revoke(input.workspaceId, input.linkId, input.now)) return null;
      return insert(input);
    },
    async revoke(input) {
      return revoke(input.workspaceId, input.linkId, input.now);
    },
    async findByToken(token) {
      const row = [...links.values()].find((link) => link.token === token);
      return row ? { link: { ...row }, workspace } : null;
    },
    async countMembers(id) {
      const memberCount = [...roles.keys()].filter((key) => key.startsWith(`${id}:`)).length;
      return { memberCount, agentCount: 2 };
    },
    async admit(input) {
      const row = links.get(input.linkId);
      if (!row || !isJoinLinkActive(row, input.now)) return { status: "inactive" };
      const key = `${row.workspaceId}:${input.userId}`;
      if (roles.has(key)) return { status: "already-member" };
      row.useCount += 1;
      roles.set(key, "member");
      return { status: "admitted", joinedChannelIds: [GENERAL_CHANNEL_ID] };
    },
  };
}
