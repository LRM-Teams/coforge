import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { createAgentDirectTask } from "#src/server/tasks/agent-direct-task.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const short = crypto.randomUUID().slice(0, 8);
const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.$disconnect();
});

/**
 * From the Tasks page, a Task for an Agent needs no channel: it is created in the person's direct
 * conversation with that Agent (started if they have none yet) and assigned to the Agent. Only an
 * Agent the person may message directly can be given one this way.
 */
let alice: { id: string };
let bob: { id: string };
let workspaceId: string;
const agents: Record<"alicePrivate" | "bobPublic" | "bobPrivate", { id: string; name: string }> =
  {} as never;
beforeAll(async () => {
  alice = await db.user.create({ data: { username: `direct-alice-${short}` } });
  bob = await db.user.create({ data: { username: `direct-bob-${short}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `direct-task-${short}`,
      name: "Direct tasks",
      members: {
        create: [
          { userId: alice.id, role: "member" },
          { userId: bob.id, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const agent = (name: string, ownerId: string, visibility: "public" | "private") =>
    db.agent.create({
      data: {
        workspaceId,
        name: `${name}-${short}`,
        displayName: name,
        ownerId,
        visibility,
        runtimeConfig: {},
      },
      select: { id: true, name: true },
    });
  agents.alicePrivate = await agent("alice-private", alice.id, "private");
  agents.bobPublic = await agent("bob-public", bob.id, "public");
  agents.bobPrivate = await agent("bob-private", bob.id, "private");
  cleanup.push(
    () => db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } }),
    () => db.workspace.delete({ where: { id: workspaceId } }),
  );
});

const create = (agentId: string, title: string) =>
  createAgentDirectTask(db, new TaskBoard(db), {
    workspaceId,
    userId: alice.id,
    agentId,
    title,
    idempotencyKey: crypto.randomUUID(),
  });

test("a Task for an Agent goes to the person's direct conversation with it, assigned to it", async () => {
  const created = await create(agents.bobPublic.id, "Draft the release notes");
  const task = created.tasks[0]!;
  expect(task).toMatchObject({ title: "Draft the release notes", status: "todo" });
  expect(task.owner).toMatchObject({ kind: "agent", id: agents.bobPublic.id });
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: task.conversationId },
    select: { channelName: true, members: { select: { userId: true, agentId: true } } },
  });
  expect(conversation.channelName).toBeNull();
  expect(conversation.members.map((member) => member.userId ?? member.agentId).sort()).toEqual(
    [alice.id, agents.bobPublic.id].sort(),
  );

  // A second Task for the same Agent reuses that conversation.
  const again = await create(agents.bobPublic.id, "Check the changelog");
  expect(again.tasks[0]!.conversationId).toBe(task.conversationId);
});

test("the person's own private Agent can be given one; someone else's private Agent cannot", async () => {
  const own = await create(agents.alicePrivate.id, "Tidy the backlog");
  expect(own.tasks[0]!.owner).toMatchObject({ id: agents.alicePrivate.id });
  await expect(create(agents.bobPrivate.id, "Not allowed")).rejects.toThrow("AGENT_DM_RESTRICTED");
});

test("an Agent made private since the conversation began can no longer be given one from here", async () => {
  // Bob's public Agent: Alice's conversation with it exists from the first test.
  await create(agents.bobPublic.id, "Before it went private");
  await db.agent.update({ where: { id: agents.bobPublic.id }, data: { visibility: "private" } });
  try {
    await expect(create(agents.bobPublic.id, "After it went private")).rejects.toThrow(
      "AGENT_DM_RESTRICTED",
    );
  } finally {
    await db.agent.update({ where: { id: agents.bobPublic.id }, data: { visibility: "public" } });
  }
});

test("a deleted Agent cannot be given one, and a retried request makes one Task", async () => {
  const deleted = await db.agent.create({
    data: {
      workspaceId,
      name: `gone-${short}`,
      displayName: "Gone",
      ownerId: alice.id,
      runtimeConfig: {},
      deletedAt: new Date(),
    },
    select: { id: true },
  });
  await expect(create(deleted.id, "Too late")).rejects.toThrow("NOT_FOUND");

  const idempotencyKey = crypto.randomUUID();
  const once = () =>
    createAgentDirectTask(db, new TaskBoard(db), {
      workspaceId,
      userId: alice.id,
      agentId: agents.alicePrivate.id,
      title: "Only once",
      idempotencyKey,
    });
  const [first, retry] = [await once(), await once()];
  expect(retry.tasks[0]!.messageId).toBe(first.tasks[0]!.messageId);
});
