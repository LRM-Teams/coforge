import type { TaskStatus, TaskView } from "@coforge/protocol";

export type TaskMoveCommand =
  | { operation: "claim"; number: number }
  | {
      operation: "update";
      number: number;
      status: TaskStatus;
      expectedRevision: number;
    };

/** Browser movement policy mirroring TaskBoard.update authorization. */
export function getTaskMoveCommand(
  task: TaskView,
  currentMemberId: string | null,
  nextStatus: TaskStatus,
): TaskMoveCommand | undefined {
  if (!currentMemberId || task.status === nextStatus) return undefined;

  if (task.status === "todo" && !task.owner && nextStatus === "in_progress") {
    return { operation: "claim", number: task.number };
  }

  const isOwner = task.owner?.memberId === currentMemberId;
  const allowedForNonOwner =
    nextStatus === "todo" ||
    nextStatus === "closed" ||
    (nextStatus === "done" && task.owner !== null);
  if (!isOwner && !allowedForNonOwner) return undefined;
  if (nextStatus !== "todo" && nextStatus !== "closed" && !task.owner) return undefined;

  return {
    operation: "update",
    number: task.number,
    status: nextStatus,
    expectedRevision: task.revision,
  };
}
