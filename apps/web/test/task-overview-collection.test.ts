import { expect, test } from "bun:test";
import { notifyManager, QueryClient } from "@tanstack/react-query";
import type { TaskCommand, TaskView } from "@lrm/coforge-sdk/internal";

import {
  createTaskOverview,
  taskOverviewQuery,
  type TaskOverviewApi,
} from "#src/features/tasks/task-overview-collection";

/**
 * The Tasks page's rows and the changes made there, against fake server calls: a move shows at
 * once and then takes the server's copy of the Task; a change with nothing to show first is still
 * saved; a refused change puts the row back.
 */
const task = (number: number, fields: Partial<TaskView> = {}): TaskView => ({
  messageId: `message-${number}`,
  conversationId: "conversation-1",
  number,
  title: `Task ${number}`,
  status: "todo",
  revision: 1,
  owner: null,
  ...fields,
});
const viewer = {
  memberId: "member-me",
  kind: "user" as const,
  id: "user-me",
  name: "Me",
  handle: "me",
};

async function overviewWith(execute: TaskOverviewApi["execute"]) {
  const commands: TaskCommand[] = [];
  let reads = 0;
  let failing = false;
  const finishedReads: Array<{ done?: number; closed?: number } | undefined> = [];
  const api: TaskOverviewApi = {
    load: async (options) => {
      reads += 1;
      finishedReads.push(options);
      if (failing) throw new Error("offline");
      return {
        more: { done: true, closed: false },
        tasks: [task(1), task(2, { status: "in_progress", owner: viewer })].map((view) => ({
          ...view,
          currentMemberId: "member-me",
          source: { channelName: "product", agentId: null, label: "#product" },
          project: { id: "project-1", name: "Launch", slug: "launch" },
        })),
      };
    },
    execute: async (command) => {
      commands.push(command);
      return execute(command);
    },
  };
  // As the app's client: data read within 30 s is fresh, so mounting does not re-read it.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  await queryClient.query(taskOverviewQuery("w", api));
  const overview = createTaskOverview(queryClient, "w", api);
  await overview.tasks.preload();
  return {
    overview,
    commands,
    queryClient,
    reads: () => reads,
    finishedReads,
    failReads: (value: boolean) => void (failing = value),
  };
}

test("a move shows at once, then takes the server's copy of the Task", async () => {
  const { overview, commands } = await overviewWith(async () => ({
    tasks: [task(1, { status: "in_progress", owner: viewer, revision: 2 })],
  }));
  const row = overview.tasks.get("message-1")!;
  const saved = overview.run(row, { operation: "claim", number: 1 });
  expect(overview.tasks.get("message-1")?.status).toBe("in_progress");
  await saved;
  expect(commands.map((command) => [command.operation, command.conversationId])).toEqual([
    ["claim", "conversation-1"],
  ]);
  // The server's owner and revision; the page's own fields (source, Project) stay.
  expect(overview.tasks.get("message-1")).toMatchObject({
    status: "in_progress",
    revision: 2,
    owner: viewer,
    project: { id: "project-1" },
  });
});

test("a change with nothing to show first is still saved and takes the server's copy", async () => {
  const { overview, commands } = await overviewWith(async () => ({
    tasks: [task(2, { status: "in_progress", owner: null, revision: 2 })],
  }));
  await overview.run(overview.tasks.get("message-2")!, { operation: "unassign", number: 2 });
  expect(commands.map((command) => command.operation)).toEqual(["unassign"]);
  expect(overview.tasks.get("message-2")).toMatchObject({ owner: null, revision: 2 });
});

test("a refused move puts the row back, rejects, and reads the list again", async () => {
  const { overview, reads } = await overviewWith(async () => {
    throw new Error("TASK_CONFLICT");
  });
  const saved = overview.run(overview.tasks.get("message-2")!, {
    operation: "update",
    number: 2,
    status: "done",
    expectedRevision: 1,
  });
  await expect(saved).rejects.toThrow("TASK_CONFLICT");
  expect(overview.tasks.get("message-2")?.status).toBe("in_progress");
  // The refusal may come from a change made elsewhere: the next try needs the current revision.
  expect(reads()).toBe(2);
});

test("a move of a Task the page no longer lists is still saved", async () => {
  const { overview, commands } = await overviewWith(async () => ({ tasks: [] }));
  const gone = { ...overview.tasks.get("message-1")!, messageId: "message-gone", number: 9 };
  await overview.run(gone, { operation: "claim", number: 9 });
  expect(commands.map((command) => command.operation)).toEqual(["claim"]);
});

const announced = (tasks: TaskView[], deleted: string[] = []) => ({
  type: "task.changed.v1" as const,
  workspaceId: "w",
  conversationId: "conversation-1",
  tasks,
  deleted,
});

test("an announced change updates its row in place, without reading the list again", async () => {
  const { overview, reads } = await overviewWith(async () => ({ tasks: [] }));
  const needsRead = overview.apply([
    announced([task(1, { status: "done", revision: 3, owner: viewer })]),
  ]);
  expect(needsRead).toBe(false);
  expect(overview.tasks.get("message-1")).toMatchObject({
    status: "done",
    revision: 3,
    owner: viewer,
    project: { id: "project-1" },
  });
  expect(reads()).toBe(1);
});

test("an announced copy no newer than the row on screen is ignored", async () => {
  const { overview } = await overviewWith(async () => ({ tasks: [] }));
  overview.apply([announced([task(2, { status: "todo", revision: 1 })])]);
  expect(overview.tasks.get("message-2")?.status).toBe("in_progress");
});

test("an announced new Task asks for one read of the list; a deleted Task leaves", async () => {
  const { overview } = await overviewWith(async () => ({ tasks: [] }));
  const needsRead = overview.apply([announced([task(7)]), announced([], ["message-2"])]);
  expect(needsRead).toBe(true);
  expect(overview.tasks.has("message-2")).toBe(false);
  expect(overview.tasks.has("message-1")).toBe(true);
});

/** Reads the list again and lets it reach the collection: Query hands a read over on a later
 * tick, so its notifications are delivered at once for the read. */
async function refetchNow(overview: { tasks: { utils: { refetch: () => Promise<unknown> } } }) {
  notifyManager.setScheduler((callback) => callback());
  try {
    await overview.tasks.utils.refetch();
  } finally {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  }
}

test("a read whose snapshot predates an announced change does not undo it", async () => {
  // The fake server keeps answering with the old list, as a read taken before the change would.
  const { overview } = await overviewWith(async () => ({ tasks: [] }));
  overview.apply([
    announced([task(1, { status: "done", revision: 3 })]),
    announced([], ["message-2"]),
  ]);
  await refetchNow(overview);
  expect(overview.tasks.get("message-1")).toMatchObject({ status: "done", revision: 3 });
  expect(overview.tasks.has("message-2")).toBe(false);
});

test("showing older finished Tasks of one status reads more of those, and every later read keeps that depth", async () => {
  const { overview, queryClient, finishedReads } = await overviewWith(async () => ({ tasks: [] }));
  expect(overview.more()).toEqual({ done: true, closed: false });
  await overview.showOlder("done");
  // A later read, as a new Task or a refresh asks for, still lists the older ones.
  await queryClient.invalidateQueries({ queryKey: taskOverviewQuery("w").queryKey });
  expect(finishedReads).toEqual([
    { done: 50, closed: 50 },
    { done: 100, closed: 50 },
    { done: 100, closed: 50 },
  ]);
});

test("a Task converted again from a deleted Task's message comes back", async () => {
  const { overview } = await overviewWith(async () => ({ tasks: [] }));
  overview.apply([announced([], ["message-2"])]);
  expect(overview.tasks.has("message-2")).toBe(false);
  // Its row is gone, so its new copy asks for a read, which no longer leaves it out.
  expect(overview.apply([announced([task(2, { revision: 7 })])])).toBe(true);
  await refetchNow(overview);
  expect(overview.tasks.get("message-2")).toMatchObject({ revision: 7 });
});

test("a failed read of older finished Tasks rejects and leaves the depth as it was", async () => {
  const { overview, queryClient, finishedReads, failReads } = await overviewWith(async () => ({
    tasks: [],
  }));
  failReads(true);
  await expect(overview.showOlder("done")).rejects.toThrow("offline");
  failReads(false);
  await queryClient.invalidateQueries({ queryKey: taskOverviewQuery("w").queryKey });
  expect(finishedReads.at(-1)).toEqual({ done: 50, closed: 50 });
});
