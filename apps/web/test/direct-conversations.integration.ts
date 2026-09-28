import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";

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
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("opening a direct conversation starts it once and names who is on the other side", async () => {
  const conversations = new DirectConversations(db);
  const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  expect(await conversations.open(workspaceId, ada.id, { agentId: helper.id })).toEqual(withAgent);
  expect(await conversations.target(workspaceId, ada.id, withAgent.conversationId)).toEqual({
    kind: "agent",
    agentId: helper.id,
  });

  const withGrace = await conversations.open(workspaceId, ada.id, { userId: grace.id });
  expect(await conversations.target(workspaceId, ada.id, withGrace.conversationId)).toEqual({
    kind: "people",
    peerUserId: grace.id,
  });
  expect(await conversations.target(workspaceId, grace.id, withGrace.conversationId)).toEqual({
    kind: "people",
    peerUserId: ada.id,
  });
});

test("only a conversation's own member finds it, and only a direct one", async () => {
  const conversations = new DirectConversations(db);
  const gracesSecret = await conversations.open(workspaceId, grace.id, { agentId: secret.id });
  await expect(
    conversations.target(workspaceId, ada.id, gracesSecret.conversationId),
  ).rejects.toThrow("NOT_FOUND");
  await expect(conversations.target(workspaceId, ada.id, channel.id)).rejects.toThrow("NOT_FOUND");
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
