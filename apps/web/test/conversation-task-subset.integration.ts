import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.$disconnect();
});

async function fixture() {
  const short = crypto.randomUUID().slice(0, 8);
  const [alice, bob, outsider] = await Promise.all(
    ["alice", "bob", "outsider"].map((name) =>
      db.user.create({ data: { username: `subset-${name}-${short}` } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-subset-${short}`,
      name: "Task subsets",
      members: { create: [{ userId: alice!.id, role: "owner" }, { userId: bob!.id }] },
      agents: {
        create: {
          name: `subset-agent-${short}`,
          displayName: "Subset Agent",
          ownerId: bob!.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  cleanup.push(
    () => db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id, outsider!.id] } } }),
    () => db.workspace.delete({ where: { id: workspace.id } }),
  );
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `subset-${short}`,
      members: { create: { userId: alice!.id } },
    },
  });
  const agent = workspace.agents[0]!;
  const bobDm = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      directKey: [bob!.id, agent.id].sort().join(":"),
      members: { create: [{ userId: bob!.id }, { agentId: agent.id }] },
    },
  });
  const board = new TaskBoard(db);
  const as = (userId: string) => ({ workspaceId: workspace.id, userId });
  const run = (command: Record<string, unknown>) =>
    board.execute(as(alice!.id), {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  return {
    alice: alice!,
    bob: bob!,
    outsider: outsider!,
    workspace,
    channel,
    bobDm,
    board,
    as,
    run,
  };
}

/**
 * A conversation page reads only the Tasks it shows: the Tasks tab's unfinished ones, the ones in
 * its message window (by the window's message sequences) and the ones its bodies name by number,
 * never the whole list. Each read carries the backing message's sequence, which the window's
 * predicate is written against.
 */
test("a conversation's Tasks are read by status, message window and number, never all at once", async () => {
  const { alice, channel, board, as, run } = await fixture();
  const titles = ["One", "Two", "Three", "Four", "Five"];
  const created = (await run({ operation: "create", titles })).tasks;
  const byTitle = (title: string) => created.find((task) => task.title === title)!;
  await run({ operation: "update", number: byTitle("Two").number, status: "closed" });
  await run({ operation: "claim", number: byTitle("Four").number });
  await run({ operation: "update", number: byTitle("Four").number, status: "done" });
  const sequences = await db.message.findMany({
    where: { id: { in: created.map((task) => task.messageId) } },
    select: { id: true, sequence: true },
  });
  const sequenceOf = (title: string) =>
    sequences.find((message) => message.id === byTitle(title).messageId)!.sequence;
  const read = (subset: Parameters<TaskBoard["conversationTasks"]>[2]) =>
    board.conversationTasks(as(alice.id), channel.id, subset);
  const titlesOf = (result: Awaited<ReturnType<typeof read>>) =>
    result.tasks.map((task) => task.title);

  const unfinished = await read({ statuses: ["todo", "in_progress", "in_review"] });
  expect(titlesOf(unfinished)).toEqual(["One", "Three", "Five"]);
  // The same copy an Agent's `list` returns, plus the message's sequence.
  const listed = await run({ operation: "list" });
  expect(unfinished.tasks[0]).toEqual({
    ...listed.tasks.find((task) => task.title === "One")!,
    sequence: sequenceOf("One"),
  });

  expect(
    titlesOf(await read({ numbers: [byTitle("Two").number, byTitle("Five").number] })),
  ).toEqual(["Two", "Five"]);
  expect(titlesOf(await read({ sequenceFrom: sequenceOf("Three") }))).toEqual([
    "Three",
    "Four",
    "Five",
  ]);
  // A window pinned in history is bounded on both sides.
  expect(
    titlesOf(await read({ sequenceFrom: sequenceOf("Two"), sequenceTo: sequenceOf("Four") })),
  ).toEqual(["Two", "Three", "Four"]);
  // Constraints given together all apply.
  expect(
    titlesOf(await read({ statuses: ["done", "closed"], sequenceFrom: sequenceOf("Three") })),
  ).toEqual(["Four"]);
  // A read with nothing to narrow it would be the whole list.
  await expect(read({})).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(read({ numbers: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("a conversation's Tasks are read as `list` allows: a channel's by any Workspace member, a direct message's by its members only", async () => {
  const { alice, bob, outsider, channel, bobDm, board, as, run } = await fixture();
  await run({ operation: "create", title: "Channel task" });
  // A Workspace member outside the channel still reads a channel's Tasks, as `list` allows.
  expect(
    (await board.conversationTasks(as(bob.id), channel.id, { numbers: [1] })).tasks.map(
      (task) => task.title,
    ),
  ).toEqual(["Channel task"]);
  await expect(
    board.conversationTasks(as(alice.id), bobDm.id, { numbers: [1] }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    board.conversationTasks(as(outsider.id), channel.id, { numbers: [1] }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});
