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
 * The Tasks page lists every open Task, and reads Done and Closed apart, latest first and a page
 * at a time, since those only grow; the counts cover every finished Task, not only those read.
 */
test("the overview lists every open Task; finished ones are read latest first, a page at a time", async () => {
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

  // One batch shares a creation instant: spread the open ones so their order is observable.
  for (const [minute, title] of ["Open 1", "Open 2"].entries())
    await db.task.update({
      where: { conversationId_number: { conversationId: channel.id, number: numberOf(title) } },
      data: { createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)) },
    });
  const overview = await board.overview(workspace.id, user.id);
  // Open Tasks newest first, so a new one is never behind "Show more".
  expect(overview.tasks.map((task) => task.title)).toEqual(["Open 2", "Open 1"]);

  const page = (status: "done" | "closed", cursor?: string | null) =>
    board.finishedPage(as, { status, window: "week", cursor, limit: 2 });
  const titlesOf = (result: { tasks: { title: string }[] }) => result.tasks.map((t) => t.title);
  const firstDone = await page("done");
  // The latest first, and a cursor while older ones exist.
  expect(titlesOf(firstDone)).toEqual(["Done 3", "Done 2"]);
  expect(firstDone.nextCursor).not.toBeNull();
  const olderDone = await page("done", firstDone.nextCursor);
  expect(titlesOf(olderDone)).toEqual(["Done 1"]);
  expect(olderDone.nextCursor).toBeNull();
  const closed = await page("closed");
  expect(titlesOf(closed)).toEqual(["Closed 2", "Closed 1"]);
  expect(closed.nextCursor).toBeNull();

  const summary = await board.finishedSummary(as, { window: "week" });
  const counts = Object.fromEntries(
    ["done", "closed"].map((status) => [
      status,
      summary.groups
        .filter((group) => group.status === status)
        .reduce((sum, g) => sum + g.count, 0),
    ]),
  );
  expect(counts).toEqual({ done: 3, closed: 2 });
});
