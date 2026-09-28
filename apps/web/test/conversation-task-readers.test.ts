import { expect, test } from "bun:test";
import type { TaskView } from "@lrm/coforge-sdk/internal";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { taskView } from "./fixtures/task-view";

import { writeTaskChanges } from "#src/features/tasks/conversation-task-changes";
import {
  conversationTasksQuery,
  messageTaskReader,
  numberedTaskReader,
} from "#src/features/tasks/use-conversation-tasks";

/**
 * A message row reads the one Task it shows — the Task a message became, or the Task a body
 * references — from the conversation's cached list, and is told when that Task changes and only
 * then; the list's owner (`useConversationTasks`) keeps it read and live.
 */

const keys = {
  list: conversationTasksQuery("conversation-1").queryKey,
  finished: ["task", "finished", "workspace-1", "conversation-1"] as const,
};

function readerFixture(options: ReturnType<typeof numberedTaskReader>, updatedAt?: number) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.list, [taskView(1), taskView(3)], { updatedAt });
  const observer = new QueryObserver(queryClient, options);
  const seen: Array<TaskView | undefined> = [];
  const unsubscribe = observer.subscribe((result) => seen.push(result.data));
  return {
    queryClient,
    observer,
    seen,
    done: () => {
      unsubscribe();
      queryClient.clear();
    },
  };
}

test("a reader of one Task is told when that Task changes and not when another one does", async () => {
  const reader = readerFixture(numberedTaskReader("conversation-1", 3));
  try {
    expect(reader.observer.getCurrentResult().data?.number).toBe(3);
    await writeTaskChanges(reader.queryClient, keys, [
      { tasks: [taskView(1, { status: "in_progress", revision: 2 })], deleted: [] },
    ]);
    expect(reader.seen).toHaveLength(0);
    await writeTaskChanges(reader.queryClient, keys, [
      { tasks: [taskView(3, { status: "done", revision: 2 })], deleted: [] },
    ]);
    expect(reader.seen.map((seen) => seen?.status)).toEqual(["done"]);
  } finally {
    reader.done();
  }
});

test("a reader of the Task a message became follows it by message id", async () => {
  const reader = readerFixture(messageTaskReader("conversation-1", "message-1"));
  try {
    expect(reader.observer.getCurrentResult().data?.number).toBe(1);
    await writeTaskChanges(reader.queryClient, keys, [
      { tasks: [taskView(3, { title: "Renamed", revision: 2 })], deleted: [] },
    ]);
    expect(reader.seen).toHaveLength(0);
    await writeTaskChanges(reader.queryClient, keys, [{ tasks: [], deleted: ["message-1"] }]);
    expect(reader.seen).toEqual([undefined]);
  } finally {
    reader.done();
  }
});

test("a number the conversation has no Task for reads nothing", () => {
  const reader = readerFixture(numberedTaskReader("conversation-1", 99));
  try {
    expect(reader.observer.getCurrentResult().data).toBeUndefined();
  } finally {
    reader.done();
  }
});

test("a reader mounted over a stale list never reads the list again itself", () => {
  // Rows mount as the stream scrolls; the list's owner decides when to read, not each row.
  const reader = readerFixture(numberedTaskReader("conversation-1", 3), 0);
  try {
    expect(reader.queryClient.isFetching({ queryKey: keys.list })).toBe(0);
  } finally {
    reader.done();
  }
});

test("a reader mounted before the list is first read does not read it either", () => {
  const queryClient = new QueryClient();
  const observer = new QueryObserver(queryClient, numberedTaskReader("conversation-1", 3));
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(queryClient.isFetching({ queryKey: keys.list })).toBe(0);
    expect(observer.getCurrentResult().data).toBeUndefined();
  } finally {
    unsubscribe();
    queryClient.clear();
  }
});
