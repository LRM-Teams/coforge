import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";
import { PrismaWorkspaceMemberDirectoryStore } from "#src/server/workspaces/member-directory-store.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

// Every send goes through request idempotency; these tests store each request once, and no
// transport is running.
const sending = {
  idempotency: { execute: (_scope, persist) => persist() } satisfies MessageRequestIdempotency,
  centrifugo: { publish: async () => {} },
};

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const usernames = ["ada", "grace"].map((name) => `dc-${name}-${suffix}`);
const slug = `dc-${suffix}`;
let ada: { id: string };
let grace: { id: string };
let workspaceId: string;
let helper: { id: string };
let secret: { id: string };
let channel: { id: string };

beforeAll(async () => {
  [ada, grace] = await Promise.all(
    usernames.map((username) => db.user.create({ data: { username } })),
  );
  const workspace = await db.workspace.create({
    data: { slug, name: "Direct", members: { create: [{ userId: ada.id }, { userId: grace.id }] } },
  });
  workspaceId = workspace.id;
  const agent = (name: string, ownerId: string, visibility = "public") =>
    db.agent.create({
      data: { workspaceId, ownerId, name, displayName: name, visibility, runtimeConfig: {} },
    });
  [helper, secret] = await Promise.all([
    agent(`helper-${suffix}`, ada.id),
    agent(`secret-${suffix}`, grace.id, "private"),
  ]);
  channel = await db.conversation.create({
    data: { workspaceId, channelName: `dc-${suffix}`, members: { create: [{ userId: ada.id }] } },
  });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug } });
  await db.computer.deleteMany({ where: { machineId: `dc-${suffix}` } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("opening a direct conversation starts it once and names who is on the other side", async () => {
  const conversations = new DirectConversations(db);
  const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  expect(await conversations.open(workspaceId, ada.id, { agentId: helper.id })).toEqual(withAgent);
  expect(await conversations.authorize(workspaceId, ada.id, withAgent.conversationId)).toEqual({
    kind: "agent",
    agentId: helper.id,
  });

  const withGrace = await conversations.open(workspaceId, ada.id, { userId: grace.id });
  expect(await conversations.authorize(workspaceId, ada.id, withGrace.conversationId)).toEqual({
    kind: "people",
    peerUserId: grace.id,
  });
  expect(await conversations.authorize(workspaceId, grace.id, withGrace.conversationId)).toEqual({
    kind: "people",
    peerUserId: ada.id,
  });
});

test("only a conversation's own member finds it, and only a direct one", async () => {
  const conversations = new DirectConversations(db);
  const gracesSecret = await conversations.open(workspaceId, grace.id, { agentId: secret.id });
  await expect(
    conversations.authorize(workspaceId, ada.id, gracesSecret.conversationId),
  ).rejects.toThrow("NOT_FOUND");
  await expect(conversations.authorize(workspaceId, ada.id, channel.id)).rejects.toThrow(
    "NOT_FOUND",
  );
  // Another member's private Agent cannot be opened at all.
  await expect(conversations.open(workspaceId, ada.id, { agentId: secret.id })).rejects.toThrow();
});

test("only an Agent's own creator starts a DM with it, and never with a deleted one", async () => {
  const conversations = new DirectConversations(db);
  // Ada's public Agent: Grace sees it but may not message it.
  await expect(conversations.open(workspaceId, grace.id, { agentId: helper.id })).rejects.toThrow(
    "ACCESS_DENIED",
  );
  const gone = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: `gone-${suffix}`,
      displayName: "Gone",
      runtimeConfig: {},
      deletedAt: new Date(),
    },
  });
  await expect(conversations.open(workspaceId, ada.id, { agentId: gone.id })).rejects.toThrow(
    "ACCESS_DENIED",
  );
  expect(
    await db.conversation.count({
      where: { workspaceId, directKey: { contains: gone.id } },
    }),
  ).toBe(0);
});

test("the directory names the viewer's own DM with each Agent, once there is one", async () => {
  const quiet = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: `quiet-${suffix}`,
      displayName: "Quiet",
      runtimeConfig: {},
    },
  });
  const { conversationId } = await new DirectConversations(db).open(workspaceId, ada.id, {
    agentId: helper.id,
  });
  const directory = await new WorkspaceMembers(db).directory(workspaceId, ada.id);
  const dmOf = (agentId: string) => directory.agents.find((agent) => agent.id === agentId)?.dmId;
  expect(dmOf(helper.id)).toBe(conversationId);
  expect(dmOf(quiet.id)).toBeNull();
});

test("a DM with an Agent is its creator's alone, and a deleted Agent's DM stays readable only", async () => {
  const conversations = new DirectConversations(db);
  const own = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  expect(
    await conversations.authorize(workspaceId, ada.id, own.conversationId, { canSend: true }),
  ).toEqual({ kind: "agent", agentId: helper.id });

  // A member row alone does not make Grace its reader: the DM is Ada's with her own Agent.
  await db.conversationMember.create({
    data: { conversationId: own.conversationId, workspaceId, userId: grace.id },
  });
  await expect(conversations.authorize(workspaceId, grace.id, own.conversationId)).rejects.toThrow(
    "ACCESS_DENIED",
  );

  const retired = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: `retired-${suffix}`,
      displayName: "Retired",
      runtimeConfig: {},
    },
  });
  const kept = await conversations.open(workspaceId, ada.id, { agentId: retired.id });
  await db.agent.update({ where: { id: retired.id }, data: { deletedAt: new Date() } });
  expect(await conversations.authorize(workspaceId, ada.id, kept.conversationId)).toEqual({
    kind: "agent",
    agentId: retired.id,
  });
  await expect(
    conversations.authorize(workspaceId, ada.id, kept.conversationId, { canSend: true }),
  ).rejects.toThrow("NOT_FOUND");
});

test("an Agent's creator reads only their own DM with it, not another member's", async () => {
  // Grace's DM with Ada's public Agent, from before only a creator could start one.
  const gracesDm = await new PrismaDirectConversationRepository(db).getOrCreateUserAgent(
    workspaceId,
    grace.id,
    helper.id,
  );
  await db.conversationMember.create({
    data: { conversationId: gracesDm.id, workspaceId, userId: ada.id },
  });
  await expect(
    new DirectConversations(db).authorize(workspaceId, ada.id, gracesDm.id),
  ).rejects.toThrow("ACCESS_DENIED");
});

test("a DM between members reads, sends and is read by its conversation id", async () => {
  const conversations = new DirectConversations(db);
  const { conversationId } = await conversations.open(workspaceId, ada.id, { userId: grace.id });
  const sent = await conversations.send(
    workspaceId,
    ada.id,
    conversationId,
    { requestId: crypto.randomUUID(), body: "Lunch at noon?" },
    sending,
  );

  const page = await conversations.page(workspaceId, grace.id, conversationId);
  expect(page).toMatchObject({ kind: "people", peer: { id: ada.id, username: usernames[0] } });
  expect(page.messages.map((message) => message.body)).toEqual(["Lunch at noon?"]);
  expect(await conversations.updates(workspaceId, grace.id, conversationId, 0)).toHaveLength(1);

  await conversations.markRead(workspaceId, grace.id, conversationId, sent.sequence);
  expect(
    (await conversations.page(workspaceId, grace.id, conversationId)).readThroughSequence,
  ).toBe(sent.sequence);
});

test("a member's DM with themself names them on the other side", async () => {
  const conversations = new DirectConversations(db);
  const { conversationId } = await conversations.open(workspaceId, ada.id, { userId: ada.id });
  expect(await conversations.page(workspaceId, ada.id, conversationId)).toMatchObject({
    kind: "people",
    peer: { id: ada.id },
  });
});

test("a DM with an Agent reads by its conversation id, the Agent on the other side", async () => {
  const conversations = new DirectConversations(db);
  const { conversationId } = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  expect(await conversations.page(workspaceId, ada.id, conversationId)).toMatchObject({
    kind: "agent",
    agent: { id: helper.id },
  });
  await expect(conversations.page(workspaceId, grace.id, conversationId)).rejects.toThrow(
    "ACCESS_DENIED",
  );
});

test("a send in a DM with an Agent is stored as the viewer's and read back", async () => {
  const conversations = new DirectConversations(db);
  // Delivered to, so it runs on a Computer.
  const computer = await db.computer.create({
    data: { ownerId: ada.id, machineId: `dc-${suffix}` },
  });
  const scribe = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      computerId: computer.id,
      name: `scribe-${suffix}`,
      displayName: "Scribe",
      runtimeConfig: {},
    },
  });
  const { conversationId } = await conversations.open(workspaceId, ada.id, { agentId: scribe.id });
  const sent = await conversations.send(
    workspaceId,
    ada.id,
    conversationId,
    { requestId: crypto.randomUUID(), body: "Ship it" },
    sending,
  );
  const page = await conversations.page(workspaceId, ada.id, conversationId);
  expect(sent.senderMemberId).toBe(page.senderMemberId);
  expect(page.messages.at(-1)).toMatchObject({ id: sent.id, body: "Ship it" });
});

test("a DM names the member on the other side after they left the Workspace", async () => {
  const conversations = new DirectConversations(db);
  const lin = await db.user.create({ data: { username: `dc-lin-${suffix}` } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const { conversationId } = await conversations.open(workspaceId, ada.id, { userId: lin.id });
  // Leaving the Workspace ends their side of it; the conversation stays Ada's to read.
  await new PrismaWorkspaceMemberDirectoryStore(db).removeMember(workspaceId, lin.id);
  expect(await conversations.page(workspaceId, ada.id, conversationId)).toMatchObject({
    kind: "people",
    peer: { id: lin.id },
  });
  // Nobody outside the pair reads it.
  await expect(conversations.page(workspaceId, grace.id, conversationId)).rejects.toThrow(
    "NOT_FOUND",
  );
  await db.conversation.delete({ where: { id: conversationId } });
  await db.user.delete({ where: { id: lin.id } });
});
