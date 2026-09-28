import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  CentrifugoConversationRealtime,
  type TaskChangedSignal,
} from "#src/server/conversations/conversation-realtime.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const cleanup: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.$disconnect();
});

/**
 * Every Task write announces the Tasks it changed, with their new copies, so an open Tasks page
 * updates those rows without reading its list again: a channel's Tasks to the whole Workspace, a
 * direct message's only to its human viewer.
 */
let alice: { id: string };
let agent: { id: string };
let workspaceId: string;
beforeAll(async () => {
  alice = await db.user.create({ data: { username: `realtime-alice-${handle}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-realtime-${handle}`,
      name: "Task realtime",
      members: { create: [{ userId: alice.id, role: "owner" }] },
      agents: {
        create: {
          name: `realtime-agent-${handle}`,
          displayName: "Realtime Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  agent = workspace.agents[0]!;
  cleanup.push(
    () => db.user.deleteMany({ where: { id: alice.id } }),
    () => db.workspace.delete({ where: { id: workspace.id } }),
  );
});

async function boardFor(conversation: { channelName?: string; directKey?: string }) {
  const created = await db.conversation.create({
    data: {
      workspaceId,
      ...conversation,
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
  });
  const announced: TaskChangedSignal[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable() {},
      async taskChanged(signal) {
        announced.push(signal);
      },
    },
  });
  const run = (command: Record<string, unknown>) =>
    board.execute({ workspaceId, userId: alice.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: created.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  /** What was announced since the last call, as (Task number, status, revision) and deletions. */
  const drain = () => {
    const signals = announced.splice(0);
    return signals.map((signal) => ({
      tasks: signal.tasks.map((task) => [task.number, task.status, task.revision]),
      deleted: signal.deleted,
      userId: signal.userId,
    }));
  };
  return { run, drain, announced };
}

test("a channel's Task writes announce each changed Task to the Workspace, once per write", async () => {
  const { run, drain } = await boardFor({ channelName: `realtime-${handle}` });
  const [first, second] = (await run({ operation: "create", titles: ["One", "Two"] })).tasks;
  expect(drain()).toEqual([
    {
      tasks: [
        [first!.number, "todo", first!.revision],
        [second!.number, "todo", second!.revision],
      ],
      deleted: [],
      userId: undefined,
    },
  ]);

  const claimed = (await run({ operation: "claim", number: first!.number })).tasks[0]!;
  await run({ operation: "update", number: first!.number, status: "in_review" });
  // A move to the status the Task already has still takes a new revision, which the page needs
  // for its next move, so it is announced too.
  await run({ operation: "update", number: first!.number, status: "in_review" });
  expect(drain()).toEqual([
    { tasks: [[first!.number, "in_progress", claimed.revision]], deleted: [], userId: undefined },
    {
      tasks: [[first!.number, "in_review", claimed.revision + 1]],
      deleted: [],
      userId: undefined,
    },
    {
      tasks: [[first!.number, "in_review", claimed.revision + 2]],
      deleted: [],
      userId: undefined,
    },
  ]);

  await run({ operation: "delete", number: second!.number });
  expect(drain()).toEqual([{ tasks: [], deleted: [second!.messageId], userId: undefined }]);
});

test("a direct message's Task writes are announced only to its human viewer", async () => {
  const { run, announced } = await boardFor({ directKey: `${alice.id}:${agent.id}` });
  await run({ operation: "create", title: "Private work" });
  expect(announced).toHaveLength(1);
  expect(announced[0]).toMatchObject({ workspaceId, userId: alice.id, agentId: agent.id });
});

test("a Task write's announcement and its message signal never share a publication key on a channel", async () => {
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `realtime-keys-${handle}`,
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
  });
  // Centrifugo drops a second publication with the same key on the same channel.
  const published: string[] = [];
  const centrifugo = {
    async publish() {},
    async broadcast() {},
    async publishJson(channel: string, _data: unknown, key?: string) {
      published.push(`${channel} ${key}`);
    },
  };
  const board = new TaskBoard(db, { realtime: new CentrifugoConversationRealtime(centrifugo) });
  const run = (command: Record<string, unknown>) =>
    board.execute({ workspaceId, userId: alice.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: conversation.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  const created = (await run({ operation: "create", title: "Keyed" })).tasks[0]!;
  await run({ operation: "claim", number: created.number });
  await run({ operation: "unclaim", number: created.number });
  await run({ operation: "delete", number: created.number });
  expect(published.filter((entry) => entry.startsWith("chat:workspace:")).length).toBeGreaterThan(
    4,
  );
  expect(new Set(published).size).toBe(published.length);
});

test("a direct conversation without exactly one person and one Agent announces its Tasks nowhere", async () => {
  // The member rows can go (a hard-deleted user); its Tasks must not fall back to the Workspace.
  const lonely = await db.conversation.create({
    data: {
      workspaceId,
      directKey: `${alice.id}:${crypto.randomUUID()}`,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const announced: TaskChangedSignal[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable() {},
      async taskChanged(signal) {
        announced.push(signal);
      },
    },
  });
  await board.execute({ workspaceId, userId: alice.id }, {
    idempotencyKey: crypto.randomUUID(),
    conversationId: lonely.id,
    operation: "create",
    title: "Nowhere",
  } as Parameters<TaskBoard["execute"]>[1]);
  expect(announced).toEqual([]);
});
