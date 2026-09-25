import { expect, test } from "bun:test";
import type { TaskView } from "@lrm/coforge-sdk/internal";

import { applyTaskChanges } from "#src/features/tasks/conversation-task-changes";

/**
 * A conversation's cached Task list takes a burst of announced changes (or a command's own result)
 * in one write, and says whether Done or Closed changed, so the Tasks tab reads its finished counts
 * and pages again only then — and never again for the echo of a change it already holds.
 */
const task = (number: number, fields: Partial<TaskView> = {}): TaskView => ({
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
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
  ...fields,
});

test("a burst applies every change in one list, newest copy winning", () => {
  const current = [task(1), task(2)];
  const { tasks, finishedChanged } = applyTaskChanges(current, [
    { tasks: [task(1, { status: "in_progress", revision: 2 })], deleted: [] },
    { tasks: [task(1, { status: "in_review", revision: 3 }), task(3)], deleted: [] },
    { tasks: [task(1, { status: "in_progress", revision: 2 })], deleted: ["message-2"] },
  ]);
  expect(tasks.map(({ number, status }) => [number, status])).toEqual([
    [1, "in_review"],
    [3, "todo"],
  ]);
  expect(finishedChanged).toBe(false);
});

test("Done or Closed changed: a Task moved into or out of them, or a finished Task deleted", () => {
  const current = [task(1), task(2, { status: "done" }), task(3, { status: "closed" })];
  const into = applyTaskChanges(current, [
    { tasks: [task(1, { status: "done", revision: 2 })], deleted: [] },
  ]);
  const outOf = applyTaskChanges(current, [
    { tasks: [task(2, { status: "todo", revision: 2 })], deleted: [] },
  ]);
  const deleted = applyTaskChanges(current, [{ tasks: [], deleted: ["message-3"] }]);
  const newFinished = applyTaskChanges(current, [
    { tasks: [task(4, { status: "closed" })], deleted: [] },
  ]);
  expect([into, outOf, deleted, newFinished].map((result) => result.finishedChanged)).toEqual([
    true,
    true,
    true,
    true,
  ]);
});

test("the echo of a change the list already holds changes nothing", () => {
  const moved = task(1, { status: "done", revision: 2 });
  const { tasks, finishedChanged } = applyTaskChanges(
    [moved],
    [{ tasks: [moved], deleted: ["message-9"] }],
  );
  expect(tasks).toEqual([moved]);
  expect(finishedChanged).toBe(false);
});

test("an older copy never replaces a newer one", () => {
  const current = [task(1, { status: "done", revision: 3 })];
  const { tasks, finishedChanged } = applyTaskChanges(current, [
    { tasks: [task(1, { status: "todo", revision: 2 })], deleted: [] },
  ]);
  expect(tasks).toEqual(current);
  expect(finishedChanged).toBe(false);
});
