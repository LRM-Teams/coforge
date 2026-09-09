import { describe, expect, test } from "bun:test";
import type { TaskStatus, TaskView } from "@coforge/protocol";
import { getTaskMoveCommand } from "../src/features/tasks/task-move";

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

  test("claims only an unowned todo moved to in progress", () => {
    expect(getTaskMoveCommand(task("todo"), "me", "in_progress")).toEqual({
      operation: "claim",
      number: 7,
    });
    expect(getTaskMoveCommand(task("todo"), "me", "in_review")).toBeUndefined();
    expect(getTaskMoveCommand(task("todo"), "me", "done")).toBeUndefined();
    expect(getTaskMoveCommand(task("todo", owner("other")), "me", "in_progress")).toBeUndefined();
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

  test("limits other humans to todo, done, and closed without stealing ownership", () => {
    const someoneElses = task("in_review", owner("other"));
    for (const nextStatus of ["todo", "done", "closed"] as const) {
      expect(getTaskMoveCommand(someoneElses, "me", nextStatus)).toEqual({
        operation: "update",
        number: 7,
        status: nextStatus,
        expectedRevision: 4,
      });
    }
    expect(getTaskMoveCommand(someoneElses, "me", "in_progress")).toBeUndefined();
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
