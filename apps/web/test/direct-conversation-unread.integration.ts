import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * Direct-message unread counts against real PostgreSQL. The mocked repository test
 * can only assert the SQL text; this one pins the behavior the badge actually depends on: the
 * count is keyed by the conversation's *agent* member row (a DM has two member rows, so the
 * viewer's own row has a null `agentId`), zero-unread DMs still produce a row so a later event
 * can bump them live, and `markReadForUser` is monotone and clamped.
 */
test("DM unread counts are keyed by the conversation's Agent member and survive a zero count", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `alice-${suffix}` } });
  // A second user with no direct conversation at all: the badge read must return nothing.
  const bob = await db.user.create({ data: { username: `bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "DM unread",
      members: { create: [{ userId: alice.id }] },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: alice.id,
      name: `agent-${suffix}`,
      displayName: "Agent",
      runtimeConfig: {},
    },
  });
  try {
    const conversations = new PrismaDirectConversationRepository(db);
    const conversation = await conversations.getOrCreateUserAgent(workspace.id, alice.id, agent.id);
    const agentMessage = (body: string, threadRootId?: string) =>
      conversations.sendAgentMessage(conversation.id, agent.id, body, undefined, threadRootId);

    // The Agent's own two top-level messages are unread for Alice, keyed by the Agent id.
    await agentMessage("first");
    const root = await agentMessage("second");
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 2 },
    ]);

    // A thread reply never counts toward the DM's unread.
    await agentMessage("a reply", root!.id);
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 2 },
    ]);

    // Alice's own message never counts for her.
    const aliceMember = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: conversation.id, userId: alice.id } },
      select: { id: true },
    });
    await conversations.sendMessage(conversation.id, aliceMember.id, alice.id, "my own");
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 2 },
    ]);

    // markRead advances the cursor; a stale boundary cannot move it backwards, and an
    // over-eager one is clamped to the conversation's current end.
    await conversations.markReadForUser(workspace.id, alice.id, agent.id, 10_000);
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 0 },
    ]);
    await conversations.markReadForUser(workspace.id, alice.id, agent.id, 1);
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 0 },
    ]);

    // A fully-read DM still produces a row, so a later event can bump its badge live.
    await agentMessage("after read");
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 1 },
    ]);

    // A user with no direct conversation has no DM badges.
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: bob.id },
    });
    expect(await conversations.unreadCountsForUser(workspace.id, bob.id)).toEqual([]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("a closed DM stays closed until the Agent posts a top-level message after the close", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `alice-${suffix}` } });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Closed DM", members: { create: [{ userId: alice.id }] } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: alice.id,
      name: `agent-${suffix}`,
      displayName: "Agent",
      runtimeConfig: {},
    },
  });
  try {
    const conversations = new PrismaDirectConversationRepository(db);
    const conversation = await conversations.getOrCreateUserAgent(workspace.id, alice.id, agent.id);
    const agentMessage = (body: string, threadRootId?: string) =>
      conversations.sendAgentMessage(conversation.id, agent.id, body, undefined, threadRootId);
    const closed = async () =>
      (await conversations.preferencesForUser(workspace.id, alice.id)).hidden;

    const root = await agentMessage("before the close");
    await conversations.setHiddenForUser(workspace.id, alice.id, agent.id, true);
    expect(await closed()).toEqual([agent.id]);

    // Alice's own message and an Agent thread reply leave it closed.
    await Bun.sleep(2); // createdAt and hiddenAt are millisecond timestamps
    const aliceMember = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: conversation.id, userId: alice.id } },
      select: { id: true },
    });
    await conversations.sendMessage(conversation.id, aliceMember.id, alice.id, "my own");
    await agentMessage("a reply", root!.id);
    expect(await closed()).toEqual([agent.id]);

    await agentMessage("after the close");
    expect(await closed()).toEqual([]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: alice.id } });
    await db.$disconnect();
  }
});

test("a DM marked unread below its read cursor counts from the marker until a read clears it", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `alice-${suffix}` } });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "DM marker", members: { create: [{ userId: alice.id }] } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: alice.id,
      name: `agent-${suffix}`,
      displayName: "Agent",
      runtimeConfig: {},
    },
  });
  try {
    const conversations = new PrismaDirectConversationRepository(db);
    const conversation = await conversations.getOrCreateUserAgent(workspace.id, alice.id, agent.id);
    const agentMessage = (body: string) =>
      conversations.sendAgentMessage(conversation.id, agent.id, body);

    await agentMessage("one");
    await agentMessage("two");
    await conversations.markReadForUser(workspace.id, alice.id, agent.id, 10_000);
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 0 },
    ]);

    // Marked unread: the newest message counts again although the cursor is past it.
    await conversations.setUnreadForUser(workspace.id, alice.id, agent.id, true);
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 1 },
    ]);
    await agentMessage("three");
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 2 },
    ]);

    // Reading through the end clears the marker.
    await conversations.markReadForUser(workspace.id, alice.id, agent.id, 10_000);
    expect(await conversations.unreadCountsForUser(workspace.id, alice.id)).toEqual([
      { agentId: agent.id, unread: 0 },
    ]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: alice.id } });
    await db.$disconnect();
  }
});
