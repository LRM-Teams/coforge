import type { TaskView } from "@lrm/coforge-sdk/internal";
import { usePrefetchQuery, useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import {
  DirectConversation,
  type TaskPopupControls,
} from "#src/features/conversations/direct-conversation";
import {
  useChannelConversation,
  useDirectConversation,
} from "#src/features/conversations/use-conversation-data";
import { TaskDetailDialog } from "./task-detail-dialog";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";

type OverviewTaskPopupProps = {
  /** The open Task, as the overview lists it. */
  task: OverviewTaskRow;
  /** The overview's Tasks of the same conversation: what the popup offers until the
   * conversation's own Task list has loaded. */
  conversationTasks: TaskView[];
  /** Opens another Task of the same conversation (a `task #N` chip in the thread). */
  onOpenTask: (number: number) => void;
  onClose: () => void;
  /** The overview's own command path, for the popup shown when the conversation cannot load. */
  onCommand: (command: OverviewTaskCommand) => Promise<void>;
  /** The popup's live copy of a Task is newer than the overview's: re-read the overview. */
  onTaskChanged: () => void;
};

/**
 * The Tasks page's Task popup: the same popup a conversation shows — the Task, its thread and
 * the reply composer — over the overview, read and kept live through the conversation's own
 * data (`use-conversation-data.ts`). It appears once the conversation has loaded; if it cannot
 * load, the popup shows the Task alone.
 */
export function OverviewTaskPopup(props: OverviewTaskPopupProps) {
  return (
    <ClientOnly>
      <TaskPopupBoundary {...props} />
    </ClientOnly>
  );
}

function TaskPopupBoundary(props: OverviewTaskPopupProps) {
  const { task, onClose, onCommand } = props;
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Read alongside the conversation rather than after it: both hold the popup back.
  usePrefetchQuery(channelNamesQuery(workspaceId));
  // A conversation that cannot load leaves the popup with the Task alone. The boundary only
  // records the failure; the fallback renders here, outside it, so it keeps one component type
  // (and its pending and error state) across this component's renders.
  const [conversationFailed, setConversationFailed] = useState(false);
  if (conversationFailed)
    return (
      <TaskDetailDialog
        key={task.messageId}
        task={task}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onCommand={onCommand}
        conversationName={task.source.label}
        currentMemberId={task.currentMemberId ?? null}
      />
    );
  return (
    <CatchBoundary
      getResetKey={() => task.messageId}
      errorComponent={NoFallback}
      onCatch={() => setConversationFailed(true)}
    >
      <Suspense fallback={null}>
        {task.source.agentId ? (
          <DirectTaskPopup {...props} agentId={task.source.agentId} />
        ) : (
          <ChannelTaskPopup {...props} />
        )}
      </Suspense>
    </CatchBoundary>
  );
}

/** The boundary's own fallback: nothing, for the moment until `onCatch` swaps in the popup. */
function NoFallback() {
  return null;
}

function ChannelTaskPopup(props: OverviewTaskPopupProps) {
  const { conversationProps, taskView } = useChannelConversation(props.task.conversationId);
  const { channels, tasks, taskPopup } = usePopupState(props, taskView.tasks);
  return (
    <ChannelConversation
      {...conversationProps}
      tasks={tasks}
      channels={channels}
      taskPopup={taskPopup}
    />
  );
}

function DirectTaskPopup(props: OverviewTaskPopupProps & { agentId: string }) {
  const { conversationProps, taskView } = useDirectConversation(props.agentId);
  const { channels, tasks, taskPopup } = usePopupState(props, taskView.tasks);
  return (
    <DirectConversation
      {...conversationProps}
      tasks={tasks}
      channels={channels}
      taskPopup={taskPopup}
    />
  );
}

/** What both kinds of conversation hand their popup, and the overview kept in step with it. */
function usePopupState(
  { task, conversationTasks, onOpenTask, onClose, onTaskChanged }: OverviewTaskPopupProps,
  liveTasks: TaskView[],
) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const taskPopup = useMemo<TaskPopupControls>(
    () => ({ openTaskNumber: task.number, openTask: onOpenTask, closeTask: onClose }),
    [task.number, onOpenTask, onClose],
  );
  // The conversation's own list is the live one; until it holds the open Task (still loading,
  // or its read failed) the overview's copy keeps the popup up.
  const liveRevision = liveTasks.find((candidate) => candidate.number === task.number)?.revision;
  const tasks = liveRevision === undefined ? conversationTasks : liveTasks;
  useEffect(() => {
    if (liveRevision !== undefined && liveRevision > task.revision) onTaskChanged();
  }, [liveRevision, task.revision, onTaskChanged]);
  return { channels, tasks, taskPopup };
}
