import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { arrangeConversationPins } from "#src/server/conversations/conversation-pins.server";

/**
 * The Chat sidebar's Direct messages against real PostgreSQL: the viewer's DMs with Agents and
 * with members listed, pinned, marked unread, closed and counted by conversation id, one set of
 * operations for both kinds.
 */

const sending = {
  idempotency: { execute: (_scope, persist) => persist() } satisfies MessageRequestIdempotency,
  centrifugo: { publish: async () => {} },
};

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const usernames = ["ada", "grace", "lin"].map((name) => `dl-${name}-${suffix}`);
const slug = `dl-${suffix}`;
let ada: { id: string };
let grace: { id: string };
let lin: { id: string };
let workspaceId: string;
let helper: { id: string };
let channel: { id: string };

beforeAll(async () => {
  [ada, grace, lin] = await Promise.all(
    usernames.map((username, index) =>
      db.user.create({
        data: { username, displayName: index === 1 ? "Grace Hopper" : null },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Direct list",
      members: { create: [{ userId: ada.id }, { userId: grace.id }, { userId: lin.id }] },
    },
  });
  workspaceId = workspace.id;
  helper = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: `helper-${suffix}`,
      displayName: "Helper",
      runtimeConfig: {},
    },
  });
  channel = await db.conversation.create({
    data: { workspaceId, channelName: `dl-${suffix}`, members: { create: [{ userId: ada.id }] } },
  });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

/** A fresh member of the Workspace, so each test's list starts empty. */
async function newMember(name: string) {
  const username = `dl-${name}-${suffix}`;
  usernames.push(username);
  const user = await db.user.create({ data: { username } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: user.id } });
  return user;
}

test("the list names each of the viewer's DMs by conversation id and who is on the other side", async () => {
  const conversations = new DirectConversations(db);
  const withHelper = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  const withGrace = await conversations.open(workspaceId, ada.id, { userId: grace.id });
  const withSelf = await conversations.open(workspaceId, ada.id, { userId: ada.id });
  // Grace's DM with Ada's Agent, from before only a creator could start one, with a member row
  // for Ada: Ada cannot open it, so her list leaves it out.
  const gracesDm = await new PrismaDirectConversationRepository(db).getOrCreateUserAgent(
    workspaceId,
    grace.id,
    helper.id,
  );
  await db.conversationMember.create({
    data: { conversationId: gracesDm.id, workspaceId, userId: ada.id },
  });

  const { conversations: listed } = await conversations.list(workspaceId, ada.id);
  expect(listed).toEqual([
    { conversationId: withHelper.conversationId, peer: { kind: "agent", agentId: helper.id } },
    {
      conversationId: withGrace.conversationId,
      peer: {
        kind: "people",
        userId: grace.id,
        username: usernames[1]!,
        displayName: "Grace Hopper",
        avatarUrl: null,
      },
    },
    {
      conversationId: withSelf.conversationId,
      peer: {
        kind: "people",
        userId: ada.id,
        username: usernames[0]!,
        displayName: usernames[0]!,
        avatarUrl: null,
      },
    },
  ]);
});

test("pin, mark unread and close go by conversation id, for a DM with an Agent and one between members", async () => {
  const conversations = new DirectConversations(db);
  const kay = await newMember("kay");
  const withLin = await conversations.open(workspaceId, kay.id, { userId: lin.id });
  const withSelf = await conversations.open(workspaceId, kay.id, { userId: kay.id });

  // A new pin goes after the viewer's other pins; unpinning takes it out.
  await conversations.setPinned(workspaceId, kay.id, withLin.conversationId, true);
  await conversations.setPinned(workspaceId, kay.id, withSelf.conversationId, true);
  expect((await conversations.list(workspaceId, kay.id)).pinned).toEqual([
    { conversationId: withLin.conversationId, sortOrder: 0 },
    { conversationId: withSelf.conversationId, sortOrder: 1 },
  ]);
  await conversations.setPinned(workspaceId, kay.id, withLin.conversationId, false);
  expect((await conversations.list(workspaceId, kay.id)).pinned).toEqual([
    { conversationId: withSelf.conversationId, sortOrder: 1 },
  ]);

  // Marked unread: counts from the newest top-level message although it was read; a read
  // through the end clears the marker.
  const sent = await conversations.send(
    workspaceId,
    lin.id,
    withLin.conversationId,
    { idempotencyKey: crypto.randomUUID(), body: "hello" },
    sending,
  );
  await conversations.markRead(workspaceId, kay.id, withLin.conversationId, sent.sequence);
  const unreadOf = async () =>
    (await conversations.unreadCounts(workspaceId, kay.id)).find(
      (row) => row.conversationId === withLin.conversationId,
    )?.unread;
  expect(await unreadOf()).toBe(0);
  await conversations.setUnread(workspaceId, kay.id, withLin.conversationId, true);
  expect(await unreadOf()).toBe(1);
  await conversations.setUnread(workspaceId, kay.id, withLin.conversationId, false);
  expect(await unreadOf()).toBe(0);
  await conversations.setUnread(workspaceId, kay.id, withLin.conversationId, true);
  await conversations.markRead(workspaceId, kay.id, withLin.conversationId, sent.sequence);
  expect(await unreadOf()).toBe(0);

  // Closing hides it from the viewer's list only; bringing it back clears that.
  await conversations.setHidden(workspaceId, kay.id, withLin.conversationId, true);
  expect((await conversations.list(workspaceId, kay.id)).hidden).toEqual([withLin.conversationId]);
  expect((await conversations.list(workspaceId, lin.id)).hidden).toEqual([]);
  await conversations.setHidden(workspaceId, kay.id, withLin.conversationId, false);
  expect((await conversations.list(workspaceId, kay.id)).hidden).toEqual([]);

  // The same operations on the viewer's DM with their Agent.
  const scout = await db.agent.create({
    data: {
      workspaceId,
      ownerId: kay.id,
      name: `scout-${suffix}`,
      displayName: "Scout",
      runtimeConfig: {},
    },
  });
  const withScout = await conversations.open(workspaceId, kay.id, { agentId: scout.id });
  await conversations.setPinned(workspaceId, kay.id, withScout.conversationId, true);
  await conversations.setHidden(workspaceId, kay.id, withScout.conversationId, true);
  const preferences = await conversations.list(workspaceId, kay.id);
  expect(preferences.pinned.map((pin) => pin.conversationId)).toEqual([
    withSelf.conversationId,
    withScout.conversationId,
  ]);
  expect(preferences.hidden).toEqual([withScout.conversationId]);
});

test("a preference on anything but the viewer's own DM answers NOT_FOUND and changes nothing", async () => {
  const conversations = new DirectConversations(db);
  const gracesWithLin = await conversations.open(workspaceId, grace.id, { userId: lin.id });
  for (const conversationId of [channel.id, gracesWithLin.conversationId, crypto.randomUUID()])
    for (const call of [
      () => conversations.setPinned(workspaceId, ada.id, conversationId, true),
      () => conversations.setUnread(workspaceId, ada.id, conversationId, true),
      () => conversations.setHidden(workspaceId, ada.id, conversationId, true),
    ])
      await expect(call()).rejects.toThrow("NOT_FOUND");
  expect(
    await db.conversationPin.count({ where: { conversationId: gracesWithLin.conversationId } }),
  ).toBe(0);
});

test("a closed DM comes back when someone other than the viewer posts a top-level message after the close", async () => {
  const conversations = new DirectConversations(db);
  const mo = await newMember("mo");
  const { conversationId } = await conversations.open(workspaceId, mo.id, { userId: lin.id });
  const send = (senderId: string, body: string, threadRootId?: string) =>
    conversations.send(
      workspaceId,
      senderId,
      conversationId,
      { idempotencyKey: crypto.randomUUID(), body, threadRootId },
      sending,
    );
  const closed = async () => (await conversations.list(workspaceId, mo.id)).hidden;

  const root = await send(lin.id, "before the close");
  await conversations.setHidden(workspaceId, mo.id, conversationId, true);
  await Bun.sleep(2); // createdAt and hiddenAt are millisecond timestamps
  // The viewer's own message and a reply in a thread leave it closed.
  await send(mo.id, "my own");
  await send(lin.id, "a reply", root.id);
  expect(await closed()).toEqual([conversationId]);

  await send(lin.id, "after the close");
  expect(await closed()).toEqual([]);

  // A member's DM with themself has no one else to bring it back.
  const self = await conversations.open(workspaceId, mo.id, { userId: mo.id });
  await conversations.setHidden(workspaceId, mo.id, self.conversationId, true);
  await Bun.sleep(2);
  await conversations.send(
    workspaceId,
    mo.id,
    self.conversationId,
    { idempotencyKey: crypto.randomUUID(), body: "a note to self" },
    sending,
  );
  expect(await closed()).toEqual([self.conversationId]);
});

test("badges count each DM by conversation id, DMs between members included", async () => {
  const conversations = new DirectConversations(db);
  const noor = await newMember("noor");
  const withLin = await conversations.open(workspaceId, noor.id, { userId: lin.id });
  const self = await conversations.open(workspaceId, noor.id, { userId: noor.id });
  const scribe = await db.agent.create({
    data: {
      workspaceId,
      ownerId: noor.id,
      name: `scribe-${suffix}`,
      displayName: "Scribe",
      runtimeConfig: {},
    },
  });
  const withScribe = await conversations.open(workspaceId, noor.id, { agentId: scribe.id });
  const repository = new PrismaDirectConversationRepository(db);
  await repository.sendAgentMessage(withScribe.conversationId, scribe.id, "done");
  const send = (senderId: string, conversationId: string, body: string) =>
    conversations.send(
      workspaceId,
      senderId,
      conversationId,
      { idempotencyKey: crypto.randomUUID(), body },
      sending,
    );
  await send(lin.id, withLin.conversationId, "one");
  await send(lin.id, withLin.conversationId, "two");
  // The viewer's own messages never count, in their DM with themself too.
  await send(noor.id, self.conversationId, "note");

  const counts = await conversations.unreadCounts(workspaceId, noor.id);
  expect(Object.fromEntries(counts.map((row) => [row.conversationId, row.unread]))).toEqual({
    [withLin.conversationId]: 2,
    [self.conversationId]: 0,
    [withScribe.conversationId]: 1,
  });
});

test("the list and a pin drag leave out DMs the viewer cannot open", async () => {
  const conversations = new DirectConversations(db);
  const repository = new PrismaDirectConversationRepository(db);
  const ivy = await newMember("ivy");
  // Ivy's own DM with Ada's Agent, from before only a creator could start one: its key names Ivy,
  // but the DM is not hers to use.
  const withAdasAgent = await repository.getOrCreateUserAgent(workspaceId, ivy.id, helper.id);
  // Ivy's DM with her own Agent, since deleted: kept for history, gone from the list.
  const retired = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ivy.id,
      name: `ivy-retired-${suffix}`,
      displayName: "Retired",
      runtimeConfig: {},
    },
  });
  const withRetired = await conversations.open(workspaceId, ivy.id, { agentId: retired.id });
  await db.agent.update({ where: { id: retired.id }, data: { deletedAt: new Date() } });

  expect((await conversations.list(workspaceId, ivy.id)).conversations).toEqual([]);
  for (const conversationId of [withAdasAgent.id, withRetired.conversationId])
    await expect(
      arrangeConversationPins(db, workspaceId, ivy.id, {
        pins: [{ kind: "direct", conversationId }],
        unpinned: [],
      }),
    ).rejects.toThrow("ACCESS_DENIED");
});
