import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TaskStatus } from "@lrm/coforge-sdk/internal";

/** The conversation's tasks, number → current status, for the task-reference chips in its bodies. */
const TaskReferenceStatusContext = createContext<ReadonlyMap<number, TaskStatus> | undefined>(
  undefined,
);

/** Gives every task-reference chip below it its task's current status. */
export function TaskReferenceStatusProvider({
  tasks,
  children,
}: {
  tasks: readonly { number: number; status: TaskStatus }[] | undefined;
  children: ReactNode;
}) {
  const statuses = useMemo(
    () => new Map((tasks ?? []).map((task) => [task.number, task.status])),
    [tasks],
  );
  return (
    <TaskReferenceStatusContext.Provider value={statuses}>
      {children}
    </TaskReferenceStatusContext.Provider>
  );
}

/** The statuses of the conversation's tasks; absent outside a `TaskReferenceStatusProvider`. */
export function useTaskReferenceStatuses() {
  return useContext(TaskReferenceStatusContext);
}
