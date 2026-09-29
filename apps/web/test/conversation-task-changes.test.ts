import { expect, test } from "bun:test";

import { taskView } from "./fixtures/task-view";

import { createTaskChangeBurst } from "#src/features/tasks/conversation-task-changes";
import type { TaskChanges } from "#src/features/tasks/conversation-tasks-collection";

/**
 * A conversation's announced Task changes gather into one burst, so an Agent working through
 * several Tasks writes the conversation's Tasks once (`conversation-tasks-collection.test.ts`).
 */

/** A timer the test fires by hand, so nothing waits on the clock. */
function manualTimers() {
  const due = new Map<number, () => void>();
  let next = 0;
  return {
    set: (run: () => void) => {
      next += 1;
      due.set(next, run);
      return next;
    },
    clear: (id: number | undefined) => {
      if (id !== undefined) due.delete(id);
    },
    fire: () => {
      const runs = [...due.values()];
      due.clear();
      for (const run of runs) run();
    },
    get pending() {
      return due.size;
    },
  };
}

const announced = (
  conversationId: string,
  number: number,
): TaskChanges & { conversationId: string } => ({
  conversationId,
  tasks: [taskView(number, { conversationId })],
  deleted: [],
});

test("a burst gathers its conversation's announcements and applies them in one call", () => {
  const timers = manualTimers();
  const applied: TaskChanges[][] = [];
  const burst = createTaskChangeBurst(
    "conversation-1",
    (changes) => applied.push([...changes]),
    timers,
  );
  burst.push(announced("conversation-1", 1));
  burst.push(announced("conversation-2", 2));
  burst.push(announced("conversation-1", 3));
  expect(applied).toEqual([]);
  timers.fire();
  expect(applied.map((changes) => changes.map((change) => change.tasks[0]!.number))).toEqual([
    [1, 3],
  ]);
});

test("flushing applies what is pending at once, and the burst keeps working after it", () => {
  // An effect cleanup flushes; React may run the effect again (StrictMode, Activity) and keep
  // pushing into the same buffer, which must schedule a fresh apply rather than wait on a timer
  // that was cleared.
  const timers = manualTimers();
  const applied: number[][] = [];
  const burst = createTaskChangeBurst(
    "conversation-1",
    (changes) => applied.push(changes.map((change) => change.tasks[0]!.number)),
    timers,
  );
  burst.push(announced("conversation-1", 1));
  burst.flush();
  expect(applied).toEqual([[1]]);
  expect(timers.pending).toBe(0);
  burst.flush();
  expect(applied).toEqual([[1]]);
  burst.push(announced("conversation-1", 2));
  expect(timers.pending).toBe(1);
  timers.fire();
  expect(applied).toEqual([[1], [2]]);
});
