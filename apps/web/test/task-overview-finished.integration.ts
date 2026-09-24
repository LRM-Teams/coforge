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

/**
 * The Tasks page lists every open Task, but only the most recently finished Done and Closed
 * ones, since those only grow; it says whether older ones exist, and a larger limit reads more.
 */
test("the overview lists every open Task and only the latest finished ones, saying when there are more", async () => {
  const short = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `finished-${short}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-finished-${short}`,
      name: "Finished tasks",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  cleanup.push(
    () => db.user.delete({ where: { id: user.id } }),
    () => db.workspace.delete({ where: { id: workspace.id } }),
  );
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `finished-${short}`,
      members: { create: { userId: user.id } },
    },
  });
  const board = new TaskBoard(db);
  const as = { workspaceId: workspace.id, userId: user.id };
  const run = (command: Record<string, unknown>) =>
    board.execute(as, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  const titles = ["Open 1", "Open 2", "Done 1", "Done 2", "Done 3", "Closed 1", "Closed 2"];
  const created = (await run({ operation: "create", titles })).tasks;
  const numberOf = (title: string) => created.find((task) => task.title === title)!.number;
  // Finished in this order, so "Done 3" and "Closed 2" are the latest of each.
  for (const title of ["Done 1", "Done 2", "Done 3"]) {
    await run({ operation: "claim", number: numberOf(title) });
    await run({ operation: "update", number: numberOf(title), status: "done" });
  }
  for (const title of ["Closed 1", "Closed 2"])
    await run({ operation: "update", number: numberOf(title), status: "closed" });
  // Distinct change and creation times, in that order, whatever the clock's resolution.
  for (const [index, title] of titles.entries())
    await db.task.update({
      where: { messageId: created.find((task) => task.title === title)!.messageId },
      data: {
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        updatedAt: new Date(Date.UTC(2026, 0, 2, 0, index)),
      },
    });

  const limited = await board.overview(workspace.id, user.id, { done: 2, closed: 1 });
  expect(limited.tasks.map((task) => task.title)).toEqual([
    // Open Tasks newest first, so a new one is never behind "Show more".
    "Open 2",
    "Open 1",
    // Finished ones most recently changed first, each status to its own depth.
    "Done 3",
    "Done 2",
    "Closed 2",
  ]);
  expect(limited.more).toEqual({ done: true, closed: true });

  const everything = await board.overview(workspace.id, user.id, { done: 3, closed: 2 });
  expect(everything.tasks.map((task) => task.title)).toContain("Done 1");
  expect(everything.more).toEqual({ done: false, closed: false });
});
