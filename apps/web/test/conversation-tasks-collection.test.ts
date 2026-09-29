import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { and, createLiveQueryCollection, eq, gte, inArray, lte } from "@tanstack/react-db";

import {
  createConversationTasks,
  DEMAND_GC_TIME_MS,
  messageWindowTasks,
  type ConversationTasksApi,
} from "#src/features/tasks/conversation-tasks-collection";
import { UNFINISHED_STATUSES } from "#src/features/tasks/finished-tasks";
import type {
  ConversationTask,
  ConversationTaskSubset,
} from "#src/features/tasks/conversation-task-subset";

/**
 * A conversation's Tasks as a TanStack DB collection in on-demand mode, against a fake server: each
 * live query over it (the Tasks tab, the message window, the task references) reads only its own
 * subset; announced changes and command results are written into it; each Task is read by id or
 * number from its store, so a change reaches only the readers of the Task it changed.
 */
const task = (number: number, fields: Partial<ConversationTask> = {}): ConversationTask => ({
  messageId: `message-${number}`,
  conversationId: "conversation-1",
  number,
  title: `Task ${number}`,
  status: "todo",
  revision: 1,
  owner: null,
  creator: {
    memberId: "member-creator",
    kind: "user",
    id: "user-creator",
    name: "Creator",
    handle: "creator",
  },
  createdAt: "2026-09-24T08:00:00.000Z",
  updatedAt: "2026-09-24T09:00:00.000Z",
  sequence: number * 10,
  ...fields,
});

/** The server's Tasks: a few unfinished, most of them finished, as a busy channel has. */
const serverTasks = [
  task(1),
  task(2, { status: "done" }),
  task(3, { status: "in_progress" }),
  task(4, { status: "closed" }),
  task(5, { status: "done" }),
];

/** Answers a subset as the server does: every constraint given applies. */
function matches(row: ConversationTask, subset: ConversationTaskSubset) {
  return (
    (!subset.statuses || subset.statuses.includes(row.status)) &&
    (!subset.numbers || subset.numbers.includes(row.number)) &&
    (subset.sequenceFrom === undefined || row.sequence! >= subset.sequenceFrom) &&
    (subset.sequenceTo === undefined || row.sequence! <= subset.sequenceTo)
  );
}

function fixture(rows: ConversationTask[] = serverTasks) {
  const reads: ConversationTaskSubset[] = [];
  const gates: Array<() => void> = [];
  let held = false;
  const api: ConversationTasksApi = {
    load: async (conversationId, subset) => {
      expect(conversationId).toBe("conversation-1");
      reads.push(subset);
      // Taken now, as the server's snapshot is: a gate only delays the answer.
      const answer = { tasks: rows.filter((row) => matches(row, subset)) };
      if (held) await new Promise<void>((release) => gates.push(release));
      return answer;
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  const tasks = createConversationTasks(queryClient, "conversation-1", api);
  return {
    tasks,
    reads,
    queryClient,
    hold: () => (held = true),
    release: () => {
      held = false;
      for (const open of gates.splice(0)) open();
    },
  };
}

const unfinishedQuery = (tasks: ReturnType<typeof fixture>["tasks"]) =>
  createLiveQueryCollection((q) =>
    q
      .from({ task: tasks.collection })
      .where(({ task }) => inArray(task.status, UNFINISHED_STATUSES)),
  );

test("each live query reads only its own subset; the collection holds what they read", async () => {
  const { tasks, reads } = fixture();
  const board = unfinishedQuery(tasks);
  const window = createLiveQueryCollection((q) =>
    q.from({ task: tasks.collection }).where(({ task }) => gte(task.sequence, 40)),
  );
  const references = createLiveQueryCollection((q) =>
    q.from({ task: tasks.collection }).where(({ task }) => inArray(task.number, [2])),
  );
  await Promise.all([board.preload(), window.preload(), references.preload()]);

  expect(reads).toEqual([
    { statuses: ["todo", "in_progress", "in_review"] },
    { sequenceFrom: 40 },
    { numbers: [2] },
  ]);
  expect(board.toArray.map((row) => row.number).sort()).toEqual([1, 3]);
  const { byId, byNumber } = tasks.store.state;
  expect([...byId.keys()].sort()).toEqual(
    ["message-1", "message-2", "message-3", "message-4", "message-5"].sort(),
  );
  expect(byNumber.get(4)?.status).toBe("closed");
});

test("an announced change reaches only the reader of the Task it changed", async () => {
  const { tasks } = fixture();
  await unfinishedQuery(tasks).preload();
  const before = tasks.store.state;
  tasks.apply([{ tasks: [task(1, { status: "in_review", revision: 2 })], deleted: [] }]);
  const after = tasks.store.state;
  expect(after.byId.get("message-1")?.status).toBe("in_review");
  expect(after.byNumber.get(1)).toBe(after.byId.get("message-1"));
  // The other Task keeps its very object, so a selector reading it reports no change.
  expect(after.byId.get("message-3")).toBe(before.byId.get("message-3")!);
  expect(after.byNumber.get(3)).toBe(before.byNumber.get(3)!);
  // Its read sequence survives a copy that does not carry one.
  expect(after.byId.get("message-1")?.sequence).toBe(10);
});

test("announced changes: a newer copy replaces, an echo changes nothing, an unknown Task joins, a deletion leaves", async () => {
  const { tasks } = fixture();
  await unfinishedQuery(tasks).preload();
  const echo = tasks.apply([{ tasks: [task(1)], deleted: [] }]);
  expect(echo.finishedChanged).toBe(false);
  // A new Task (never changed before) cannot have left Done or Closed.
  const created = tasks.apply([
    { tasks: [task(9, { sequence: undefined, revision: 0 })], deleted: [] },
  ]);
  expect(tasks.store.state.byNumber.get(9)?.title).toBe("Task 9");
  expect(created.finishedChanged).toBe(false);
  const deleted = tasks.apply([{ tasks: [], deleted: ["message-3"] }]);
  expect(tasks.store.state.byId.has("message-3")).toBe(false);
  expect(deleted.finishedChanged).toBe(false);
});

test("Done and Closed are read again whenever a change may have moved a Task into or out of them", async () => {
  const { tasks } = fixture();
  await unfinishedQuery(tasks).preload();
  // Into Done.
  expect(
    tasks.apply([{ tasks: [task(1, { status: "done", revision: 2 })], deleted: [] }])
      .finishedChanged,
  ).toBe(true);
  // Out of Done, for a Task the collection does not hold: whatever it was is unknown.
  expect(
    tasks.apply([{ tasks: [task(5, { status: "todo", revision: 3 })], deleted: [] }])
      .finishedChanged,
  ).toBe(true);
  // A deleted Task the collection does not hold may have been finished.
  expect(tasks.apply([{ tasks: [], deleted: ["message-4"] }]).finishedChanged).toBe(true);
});

test("a read that started before a change never brings the older copy, or a deleted Task, back", async () => {
  const { tasks, hold, release } = fixture();
  hold();
  const board = unfinishedQuery(tasks);
  const loaded = board.preload();
  tasks.apply([{ tasks: [task(1, { status: "in_review", revision: 2 })], deleted: ["message-3"] }]);
  release();
  await loaded;
  expect(tasks.store.state.byId.get("message-1")?.status).toBe("in_review");
  expect(tasks.store.state.byId.has("message-3")).toBe(false);
});

test("a window that moves keeps the Tasks it showed until the next window's read has answered", async () => {
  const { tasks, hold, release } = fixture();
  const first = createLiveQueryCollection({
    query: (q) => q.from({ task: tasks.collection }).where(({ task }) => gte(task.sequence, 40)),
    gcTime: DEMAND_GC_TIME_MS,
  });
  const shown = first.subscribeChanges(() => {}, { includeInitialState: true });
  await first.toArrayWhenReady();
  expect(tasks.store.state.byNumber.has(5)).toBe(true);

  hold();
  const next = createLiveQueryCollection({
    query: (q) => q.from({ task: tasks.collection }).where(({ task }) => gte(task.sequence, 30)),
    gcTime: DEMAND_GC_TIME_MS,
  });
  const loaded = next.preload();
  // The page stops showing the first window before the next one has answered, and that read takes
  // longer than an unshown live query's clean-up would (a timer, then an idle callback within 1 s).
  // The clock is what is under test here, so real time passes.
  shown.unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(tasks.store.state.byNumber.has(5)).toBe(true);
  release();
  await loaded;
  expect(tasks.store.state.byNumber.has(5)).toBe(true);
  expect(tasks.store.state.byNumber.has(3)).toBe(true);
});

test("a live query the server cannot answer as asked reads nothing and fails", async () => {
  const { tasks, reads } = fixture();
  const unanswerable = createLiveQueryCollection((q) =>
    q.from({ task: tasks.collection }).where(({ task }) => eq(task.title, "Task 1")),
  );
  await expect(unanswerable.preload()).rejects.toThrow();
  expect(reads).toEqual([]);
});

test("a message window asks for the Tasks from its first message on, and the Tasks its bodies name", () => {
  const messages = [
    { sequence: 41, body: "see <@task:3> and <@task:12>" },
    { sequence: 43, body: "plain" },
    { sequence: 47, body: "<@task:3> again, and <@task:1>" },
  ];
  // At the live end the window has no upper bound: a message that arrives later is inside it.
  expect(messageWindowTasks(messages, false)).toEqual({ sequenceFrom: 41, numbers: [1, 3, 12] });
  // A window pinned in history ends at its last message.
  expect(messageWindowTasks(messages, true)).toEqual({
    sequenceFrom: 41,
    sequenceTo: 47,
    numbers: [1, 3, 12],
  });
  expect(messageWindowTasks([], false)).toBeUndefined();
});

test("the same messages ask for the same subset, so a realtime message with no reference reads nothing", () => {
  const first = [{ sequence: 41, body: "see <@task:3>" }];
  const later = [...first, { sequence: 42, body: "hello" }];
  expect(messageWindowTasks(later, false)).toEqual(messageWindowTasks(first, false));
});

test("a burst applies every change in order, the newest copy winning", async () => {
  const { tasks } = fixture();
  await unfinishedQuery(tasks).preload();
  const { finishedChanged } = tasks.apply([
    { tasks: [task(1, { status: "in_progress", revision: 2 })], deleted: [] },
    {
      tasks: [task(1, { status: "in_review", revision: 3 }), task(7, { revision: 0 })],
      deleted: [],
    },
    { tasks: [task(1, { status: "in_progress", revision: 2 })], deleted: ["message-3"] },
  ]);
  const { byId } = tasks.store.state;
  expect([...byId.values()].map(({ number, status }) => [number, status]).sort()).toEqual([
    [1, "in_review"],
    [7, "todo"],
  ]);
  expect(finishedChanged).toBe(false);
});

test("an older copy never replaces a newer one", async () => {
  const { tasks } = fixture();
  await unfinishedQuery(tasks).preload();
  tasks.apply([{ tasks: [task(1, { status: "in_review", revision: 3 })], deleted: [] }]);
  const older = tasks.apply([{ tasks: [task(1, { status: "todo", revision: 2 })], deleted: [] }]);
  expect(tasks.store.state.byNumber.get(1)?.status).toBe("in_review");
  expect(older.finishedChanged).toBe(false);
});

test("a Task that leaves Done and comes back within one burst ends Done, and Done is read again", async () => {
  const { tasks } = fixture();
  await createLiveQueryCollection((q) =>
    q.from({ task: tasks.collection }).where(({ task }) => inArray(task.number, [2])),
  ).preload();
  const { finishedChanged } = tasks.apply([
    { tasks: [task(2, { status: "todo", revision: 2 })], deleted: [] },
    { tasks: [task(2, { status: "done", revision: 3 })], deleted: [] },
  ]);
  expect(tasks.store.state.byNumber.get(2)).toMatchObject({ status: "done", revision: 3 });
  expect(finishedChanged).toBe(true);
});

test("a window pinned in history reads the Tasks between its first and last message", async () => {
  const { tasks, reads } = fixture();
  const pinned = createLiveQueryCollection((q) =>
    q
      .from({ task: tasks.collection })
      .where(({ task }) => and(gte(task.sequence, 20), lte(task.sequence, 40))),
  );
  await pinned.preload();
  expect(reads).toEqual([{ sequenceFrom: 20, sequenceTo: 40 }]);
  expect([...tasks.store.state.byNumber.keys()].sort()).toEqual([2, 3, 4]);
});

test("a read the server refuses leaves its live query in error, which the Tasks tab shows", async () => {
  const failing = createConversationTasks(
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    "conversation-1",
    {
      load: async () => {
        throw new Error("ACCESS_DENIED");
      },
    },
  );
  const board = unfinishedQuery(failing);
  await board.preload().catch(() => {});
  expect(board.status).toBe("error");
  expect(failing.store.state.byId.size).toBe(0);
});
