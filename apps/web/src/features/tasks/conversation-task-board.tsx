import type { TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { useMemo, useRef } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { TaskBoard, type BoardTaskCommand, type ConversationBoard } from "./task-board";
import { useTaskBoardSearch } from "./task-board-search";
import { useFinishedTasks } from "./use-finished-tasks";
import type { ConversationTasks } from "./use-conversation-tasks";

const isFinished = (status: TaskStatus) => status === "done" || status === "closed";

/**
 * A conversation's Tasks tab: the Task board scoped to one conversation. Its unfinished Tasks
 * come from the conversation's own list; Done and Closed are counted and paged by the server
 * within the finished-work window, as on the Tasks page.
 */
export function ConversationTaskBoard({
  conversationId,
  currentMemberId,
  canMutate,
  taskView,
  search,
  onOpenTask,
  ...conversation
}: Omit<ConversationBoard, "loading" | "error"> & {
  conversationId: string;
  /** The viewer's membership in the conversation; empty when they are not a member. */
  currentMemberId: string;
  canMutate: boolean;
  taskView: ConversationTasks;
  search: Parameters<typeof useTaskBoardSearch>[0];
  onOpenTask: (number: number) => void;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const view = useTaskBoardSearch(search);
  const { tasks: listed, loading, error, command } = taskView;
  // The list holds every Task, finished ones included. The board keeps an unfinished Task once it
  // has shown it, so a Task moved to Done or Closed here stays in place; the rest of Done and
  // Closed are read in pages, as the Tasks page reads them.
  const shown = useRef(new Set<string>());
  const tasks = useMemo(() => {
    const rows = [];
    for (const task of listed) {
      if (!isFinished(task.status)) shown.current.add(task.messageId);
      else if (!shown.current.has(task.messageId)) continue;
      rows.push({ ...task, currentMemberId: currentMemberId || null });
    }
    return rows;
  }, [listed, currentMemberId]);
  const finished = useFinishedTasks({
    scope: { workspaceId, conversationId },
    window: view.completedWindow,
    filter: view.filter,
    onPage: tasks,
  });
  const { refresh } = finished;
  const run = useMemo(
    () =>
      canMutate
        ? (_task: TaskView, input: BoardTaskCommand) =>
            command(input)
              .then(() => {})
              .finally(refresh)
        : undefined,
    [canMutate, command, refresh],
  );
  return (
    <TaskBoard
      tasks={tasks}
      finished={finished}
      completedWindow={view.completedWindow}
      status={view.status}
      filter={view.filter}
      layout={view.layout}
      onStatusChange={view.changeStatus}
      onFilterChange={view.changeFilter}
      onWindowChange={view.changeWindow}
      onLayoutChange={view.changeLayout}
      onOpenTask={(task) => onOpenTask(task.number)}
      onCommand={run}
      conversation={{ ...conversation, loading, error }}
    />
  );
}
