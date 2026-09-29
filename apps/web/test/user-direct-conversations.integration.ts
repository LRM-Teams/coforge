import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { UserDirectConversations } from "#src/server/conversations/user-direct-conversations.server";
import type { ConversationRealtimeMessage } from "#src/server/conversations/conversation-realtime.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID();
const usernames = ["ada", "grace", "outsider", "carol"].map((name) => `udm-${name}-${suffix}`);
const slugs = [`udm-${suffix}`, `udm-other-${suffix}`];
let ada: { id: string };
let grace: { id: string };
let outsider: { id: string };
let carol: { id: string };
let workspace: { id: string };
// Every send goes through request idempotency; these tests store each request once.
const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };

beforeAll(async () => {
  [ada, grace, outsider, carol] = await Promise.all(
    usernames.map((username) => db.user.create({ data: { username } })),
  );
  [workspace] = await Promise.all([
    db.workspace.create({
      data: {
        slug: slugs[0]!,
        name: "People DMs",
        members: { create: [{ userId: ada.id }, { userId: grace.id }, { userId: carol.id }] },
      },
    }),
    db.workspace.create({
      data: { slug: slugs[1]!, name: "Elsewhere", members: { create: [{ userId: outsider.id }] } },
    }),
  ]);
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug: { in: slugs } } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("two members share one direct conversation whoever opens it", async () => {
  const conversations = new UserDirectConversations(db, passThrough);
  const opened = await conversations.open(workspace.id, ada.id, grace.id);
  expect(await conversations.open(workspace.id, grace.id, ada.id)).toEqual(opened);
  expect(await conversations.open(workspace.id, ada.id, grace.id)).toEqual(opened);
  const members = await db.conversationMember.findMany({
    where: { conversationId: opened.conversationId },
    select: { userId: true, agentId: true },
  });
  expect(members.map((member) => member.userId).sort()).toEqual([ada.id, grace.id].sort());
  expect(members.every((member) => member.agentId === null)).toBe(true);
});

test("a member can open a direct conversation with themself", async () => {
  const conversations = new UserDirectConversations(db, passThrough);
  const opened = await conversations.open(workspace.id, ada.id, ada.id);
  expect(await conversations.open(workspace.id, ada.id, ada.id)).toEqual(opened);
  const members = await db.conversationMember.findMany({
    where: { conversationId: opened.conversationId },
  });
  expect(members.map((member) => member.userId)).toEqual([ada.id]);
});

test("only members of the Workspace can open one, with another member", async () => {
  const conversations = new UserDirectConversations(db, passThrough);
  await expect(conversations.open(workspace.id, ada.id, outsider.id)).rejects.toThrow(
    "ACCESS_DENIED",
  );
  await expect(conversations.open(workspace.id, outsider.id, ada.id)).rejects.toThrow(
    "ACCESS_DENIED",
  );
  expect(
    await db.conversation.count({
      where: { workspaceId: workspace.id, directKey: { contains: outsider.id } },
    }),
  ).toBe(0);
});

test("a member's message is stored with its attachments and reaches no Agent", async () => {
  const conversations = new UserDirectConversations(db, passThrough);
  const { conversationId } = await conversations.open(workspace.id, ada.id, grace.id);
  const attachment = await db.attachment.create({
    data: {
      workspaceId: workspace.id,
      conversationId,
      uploaderId: ada.id,
      objectKey: `udm/${suffix}/notes.txt`,
      fileName: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 5,
    },
  });
  const first = await conversations.send({
    requestId: crypto.randomUUID(),
    workspaceId: workspace.id,
    conversationId,
    senderUserId: ada.id,
    body: "hello grace",
    attachmentIds: [attachment.id],
  });
  const reply = await conversations.send({
    requestId: crypto.randomUUID(),
    workspaceId: workspace.id,
    conversationId,
    senderUserId: grace.id,
    body: "hi ada",
  });
  expect(reply.sequence).toBe(first.sequence + 1);
  expect(first.attachments.map((item) => item.fileName)).toEqual(["notes.txt"]);
  const stored = await db.message.findMany({
    where: { conversationId },
    orderBy: { sequence: "asc" },
    select: {
      body: true,
      sender: { select: { userId: true } },
      attachments: { select: { id: true } },
    },
  });
  expect(stored).toEqual([
    { body: "hello grace", sender: { userId: ada.id }, attachments: [{ id: attachment.id }] },
    { body: "hi ada", sender: { userId: grace.id }, attachments: [] },
  ]);
  expect(await db.agentMessageDelivery.count({ where: { conversationId } })).toBe(0);
});

test("only the conversation's own members can send in it", async () => {
  const conversations = new UserDirectConversations(db, passThrough);
  const { conversationId } = await conversations.open(workspace.id, ada.id, ada.id);
  await expect(
    conversations.send({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      conversationId,
      senderUserId: grace.id,
      body: "not mine",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
});

test("a send is announced to both members once, and a retried request stores nothing new", async () => {
  const announced: ConversationRealtimeMessage[] = [];
  const persisted = new Map<string, Awaited<ReturnType<MessageRequestIdempotency["execute"]>>>();
  const idempotency: MessageRequestIdempotency = {
    execute: async (scope, persist) => {
      const key = `${scope.senderKind}:${scope.senderId}:${scope.requestId}`;
      if (!persisted.has(key)) persisted.set(key, await persist());
      return persisted.get(key)!;
    },
  };
  const conversations = new UserDirectConversations(db, idempotency, {
    messageAvailable: async (message) => void announced.push(message),
  });
  const { conversationId } = await conversations.open(workspace.id, grace.id, ada.id);
  const send = () =>
    conversations.send({
      requestId: "request-1",
      workspaceId: workspace.id,
      conversationId,
      senderUserId: grace.id,
      body: "once",
    });
  const first = await send();
  const retried = await send();
  expect(retried.id).toBe(first.id);
  expect(await db.message.count({ where: { conversationId, body: "once" } })).toBe(1);
  expect(announced[0]).toMatchObject({
    conversationId,
    messageId: first.id,
    sequence: first.sequence,
    requestId: "request-1",
  });
  expect([...(announced[0]?.directUserIds ?? [])].sort()).toEqual([ada.id, grace.id].sort());
});

test("both members can use the conversation's Tasks, and nobody else", async () => {
  const { conversationId } = await new UserDirectConversations(db, passThrough).open(
    workspace.id,
    ada.id,
    grace.id,
  );
  const board = new TaskBoard(db);
  const list = (userId: string) =>
    board.execute(
      { workspaceId: workspace.id, userId },
      { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId },
    );
  // Both, whichever sorts first in `user:<a>|user:<b>`: splitting the key on ":" alone once
  // found only the second id.
  expect(await list(ada.id)).toEqual({ tasks: [] });
  expect(await list(grace.id)).toEqual({ tasks: [] });
  await expect(list(outsider.id)).rejects.toThrow("ACCESS_DENIED");
  // A Workspace member who is not one of the two.
  await expect(list(carol.id)).rejects.toThrow("ACCESS_DENIED");
});

test("a Task written in it is announced to its members, never to the Workspace", async () => {
  const { conversationId } = await new UserDirectConversations(db, passThrough).open(
    workspace.id,
    ada.id,
    grace.id,
  );
  const channels: string[] = [];
  const centrifugo = {
    publishJson: async (channel: string) => void channels.push(channel),
    publish: async () => {},
  } as unknown as CentrifugoServerApi;
  const board = new TaskBoard(db, { realtime: new CentrifugoConversationRealtime(centrifugo) });
  await board.execute({ workspaceId: workspace.id, userId: ada.id }, {
    operation: "create",
    idempotencyKey: crypto.randomUUID(),
    conversationId,
    title: "Between us",
  } as Parameters<TaskBoard["execute"]>[1]);
  expect(channels.length).toBeGreaterThan(0);
  expect(channels.filter((channel) => channel.startsWith("chat:workspace:"))).toEqual([]);
  expect(channels).toContain(`chat:user:${grace.id}`);
});

test("a member who left and came back can use the conversation again", async () => {
  const conversations = new UserDirectConversations(db, passThrough);
  const { conversationId } = await conversations.open(workspace.id, carol.id, ada.id);
  // Removing a member from the Workspace deletes their conversation member rows.
  await db.conversationMember.deleteMany({ where: { conversationId, userId: carol.id } });
  expect(await conversations.open(workspace.id, carol.id, ada.id)).toEqual({ conversationId });
  const sent = await conversations.send({
    requestId: crypto.randomUUID(),
    workspaceId: workspace.id,
    conversationId,
    senderUserId: carol.id,
    body: "back again",
  });
  expect(sent.body).toBe("back again");
});
