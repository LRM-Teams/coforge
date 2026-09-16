import type { TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";

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

  if (
    task.status === "todo" &&
    (!task.owner || task.owner.memberId === currentMemberId) &&
    nextStatus === "in_progress"
  ) {
    return { operation: "claim", number: task.number };
  }

  if (nextStatus === "done" && !task.owner) return undefined;

  return {
    operation: "update",
    number: task.number,
    status: nextStatus,
    expectedRevision: task.revision,
  };
}
