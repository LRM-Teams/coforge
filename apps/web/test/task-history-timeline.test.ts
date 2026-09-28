import { expect, test } from "bun:test";
import type { TaskHistoryChange, TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import { taskTimeline } from "#src/features/tasks/task-history-timeline";

const event = (seq: number, change: TaskHistoryChange): TaskHistoryEvent => ({
  id: `event-${seq}`,
  seq,
  actorType: "user",
  actorName: "ada",
  createdAt: "2026-09-23T06:00:00.000Z",
  ...change,
});

test("colours each node by the status after its event and carries it down the line", () => {
  const events = [
    event(1, { eventType: "created", payload: { taskNumber: 3, status: "todo" } }),
    event(2, { eventType: "assignee_changed", payload: { assigneeId: "u", assigneeType: "user" } }),
    event(3, { eventType: "status_changed", payload: { from: "todo", to: "in_progress" } }),
    event(4, { eventType: "amended", payload: { changes: { title: { from: "a", to: "b" } } } }),
    event(5, { eventType: "status_changed", payload: { from: "in_progress", to: "done" } }),
  ];
  expect(
    taskTimeline(events).map(({ event, status, lineStatus }) => ({
      seq: event.seq,
      status,
      lineStatus,
    })),
  ).toEqual([
    { seq: 1, status: "todo", lineStatus: "todo" },
    { seq: 2, status: undefined, lineStatus: "todo" },
    { seq: 3, status: "in_progress", lineStatus: "in_progress" },
    { seq: 4, status: undefined, lineStatus: "in_progress" },
    { seq: 5, status: "done", lineStatus: undefined },
  ]);
});

test("a history that starts after creation has no line colour until a status is known", () => {
  const events = [
    event(1, { eventType: "assignee_changed", payload: { assigneeId: null, assigneeType: null } }),
    event(2, { eventType: "status_changed", payload: { from: "todo", to: "closed" } }),
  ];
  expect(taskTimeline(events).map(({ status, lineStatus }) => [status, lineStatus])).toEqual([
    [undefined, undefined],
    ["closed", undefined],
  ]);
});
