import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useMemo, useState } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { isFinishedStatus } from "./finished-tasks";
import { TaskBoard, type ConversationBoard } from "./task-board";
import { useTaskBoardSearch } from "./task-board-search";
import type { OverviewTaskCommand } from "./task-overview-collection";
import { useFinishedTasks } from "./use-finished-tasks";
import type { ConversationTasks } from "./use-conversation-tasks";

/**
 * The Tasks a conversation's board holds itself: every unfinished one, and a finished one only
 * once the board showed it unfinished (moved to Done or Closed since), so it stays in place. The
 * rest of Done and Closed are read in pages, as the Tasks page reads them.
 *
 * The ids it has shown are kept in state per conversation and grown during render when a new
 * unfinished Task appears (React's "storing information from previous renders"), so a Task moved
 * to Done never drops out for a frame.
 */
function useHeldTasks(conversationId: string, listed: readonly TaskView[]) {
  const [shown, setShown] = useState(() => ({ conversationId, ids: new Set<string>() }));
  const known = shown.conversationId === conversationId ? shown.ids : undefined;
  const unseen = listed.filter(
    (task) => !isFinishedStatus(task.status) && !known?.has(task.messageId),
  );
  let ids = known ?? new Set<string>();
  if (!known || unseen.length > 0) {
    ids = new Set([...ids, ...unseen.map((task) => task.messageId)]);
    setShown({ conversationId, ids });
  }
  return useMemo(
    () => listed.filter((task) => !isFinishedStatus(task.status) || ids.has(task.messageId)),
    [listed, ids],
  );
}

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
  const held = useHeldTasks(conversationId, listed);
  const tasks = useMemo(
    () => held.map((task) => ({ ...task, currentMemberId: currentMemberId || null })),
    [held, currentMemberId],
  );
  const finished = useFinishedTasks({
    scope: { workspaceId, conversationId },
    window: view.completedWindow,
    filter: view.filter,
    onPage: tasks,
  });
  // The command writes its result into the list, which reads Done and Closed again when they
  // changed; its announcement then finds nothing new.
  const run = useMemo(
    () =>
      canMutate
        ? (_task: TaskView, input: OverviewTaskCommand) => command(input).then(() => {})
        : undefined,
    [canMutate, command],
  );
  return (
    <TaskBoard
      tasks={tasks}
      finished={finished}
      view={view}
      onOpenTask={(task) => onOpenTask(task.number)}
      onCommand={run}
      conversation={{ ...conversation, loading, error }}
    />
  );
}
