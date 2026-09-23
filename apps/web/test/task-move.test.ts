import { describe, expect, test } from "bun:test";
import type { TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { getTaskMoveCommand, taskStatusOptions } from "#src/features/tasks/task-move";

const task = (status: TaskStatus, owner: TaskView["owner"] = null): TaskView => ({
  messageId: "message-1",
  conversationId: "conversation-1",
  number: 7,
  title: "Move me",
  status,
  revision: 4,
  owner,
});

const owner = (memberId: string): NonNullable<TaskView["owner"]> => ({
  memberId,
  kind: "user",
  name: memberId,
});

describe("getTaskMoveCommand", () => {
  test("does nothing without membership or when status is unchanged", () => {
    expect(getTaskMoveCommand(task("todo"), null, "in_progress")).toBeUndefined();
    expect(getTaskMoveCommand(task("in_review", owner("me")), "me", "in_review")).toBeUndefined();
  });

  test("claims an available or self-reserved todo moved to in progress", () => {
    expect(getTaskMoveCommand(task("todo"), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("todo"), "me", "in_review")).toEqual({
      operation: "update",
      number: 7,
      status: "in_review",
      expectedRevision: 4,
    });
    expect(getTaskMoveCommand(task("todo"), "me", "done")).toBeUndefined();
    expect(getTaskMoveCommand(task("todo", owner("me")), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("todo", owner("other")), "me", "in_progress")).toEqual({
      operation: "update",
      number: 7,
      status: "in_progress",
      expectedRevision: 4,
    });
  });

  test("lets owners move to every status with revision checking", () => {
    for (const nextStatus of ["todo", "in_review", "done", "closed"] as const) {
      expect(getTaskMoveCommand(task("in_progress", owner("me")), "me", nextStatus)).toEqual({
        operation: "update",
        number: 7,
        status: nextStatus,
        expectedRevision: 4,
      });
    }
  });

  test("keeps status changes independent from assignment", () => {
    const someoneElses = task("in_review", owner("other"));
    for (const nextStatus of ["todo", "in_progress", "done", "closed"] as const) {
      expect(getTaskMoveCommand(someoneElses, "me", nextStatus)).toEqual({
        operation: "update",
        number: 7,
        status: nextStatus,
        expectedRevision: 4,
      });
    }
  });

  test("requires an owner for done but permits explicit terminal and todo updates", () => {
    expect(getTaskMoveCommand(task("in_review"), "me", "done")).toBeUndefined();
    expect(getTaskMoveCommand(task("in_review"), "me", "closed")).toEqual({
      operation: "update",
      number: 7,
      status: "closed",
      expectedRevision: 4,
    });
    expect(getTaskMoveCommand(task("done", owner("other")), "me", "todo")).toEqual({
      operation: "update",
      number: 7,
      status: "todo",
      expectedRevision: 4,
    });
  });
});

describe("taskStatusOptions", () => {
  test("offers the current status first, then the statuses a Task may move to from it", () => {
    const mine = owner("me");
    expect(taskStatusOptions(task("todo", mine), "me")).toEqual(["todo", "in_progress", "closed"]);
    expect(taskStatusOptions(task("in_progress", mine), "me")).toEqual([
      "in_progress",
      "in_review",
      "done",
      "closed",
    ]);
    expect(taskStatusOptions(task("in_review", mine), "me")).toEqual([
      "in_review",
      "done",
      "in_progress",
      "closed",
    ]);
    expect(taskStatusOptions(task("done", mine), "me")).toEqual([
      "done",
      "todo",
      "in_progress",
      "in_review",
      "closed",
    ]);
    expect(taskStatusOptions(task("closed", mine), "me")).toEqual([
      "closed",
      "todo",
      "in_progress",
    ]);
  });

  test("drops moves the viewer cannot make", () => {
    expect(taskStatusOptions(task("in_review"), "me")).toEqual([
      "in_review",
      "in_progress",
      "closed",
    ]);
    expect(taskStatusOptions(task("todo"), null)).toEqual(["todo"]);
  });
});
