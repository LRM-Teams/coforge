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

/** The statuses a Task may move to from each status, in the order the status menu lists them. */
const STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "done", "closed"],
  in_review: ["done", "in_progress", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo", "in_progress"],
};

/** The status menu's choices: the current status, then each allowed move the viewer can make. */
export function taskStatusOptions(task: TaskView, currentMemberId: string | null): TaskStatus[] {
  return [
    task.status,
    ...STATUS_TRANSITIONS[task.status].filter((next) =>
      getTaskMoveCommand(task, currentMemberId, next),
    ),
  ];
}
