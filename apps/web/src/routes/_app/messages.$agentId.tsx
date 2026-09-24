import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  DirectConversation,
  DirectConversationHeader,
} from "#src/features/conversations/direct-conversation";
import {
  ConversationLoadError,
  ConversationPending,
} from "#src/features/conversations/conversation-pending";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import {
  ensureConversationWindow,
  directConversationQuery,
} from "#src/features/conversations/conversation-queries";
import { useDirectConversation } from "#src/features/conversations/use-conversation-data";
import {
  useConversationView,
  useShownConversationTab,
} from "#src/features/conversations/use-conversation-view";
import { CONVERSATION_TABS } from "#src/features/conversations/conversation-tabs";
import { openTaskParamSchema } from "#src/features/conversations/conversation-thread-search";
import { TaskBoard } from "#src/features/tasks/task-board";
import { ConversationFilesPanel } from "#src/features/conversations/conversation-files";
import { useTaskLayout } from "#src/features/tasks/task-workflow";
import {
  agentIdFromProfileParam,
  agentProfileParamSchema,
  agentProfileTabParamSchema,
} from "#src/features/agents/profile-panel/profile-panel-search";
import { useOpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import {
  useConversationReadRequiresScroll,
  useMarkConversationSeen,
} from "#src/features/conversations/conversation-navigation";
import {
  latestTopLevelSequence,
  persistReadCursor,
} from "#src/features/conversations/conversation-unread";
import { markDirectConversationRead } from "#src/features/conversations/conversations.functions";
import { useEffect } from "react";

export const Route = createFileRoute("/_app/messages/$agentId")({
  validateSearch: z.object({
    view: z.enum(CONVERSATION_TABS).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
    message: z.uuid().optional().catch(undefined),
    threadRootId: z.uuid().optional().catch(undefined),
    task: openTaskParamSchema,
    profile: agentProfileParamSchema,
    agentTab: agentProfileTabParamSchema,
  }),
  loaderDeps: ({ search }) =>
    ({
      message: search.message,
      threadRootId: search.threadRootId,
    }) as const,
  remountDeps: ({ params }) => params.agentId,
  loader: ({ context, params, deps }) =>
    ensureConversationWindow(
      context.queryClient,
      directConversationQuery(params.agentId).query,
      deps.threadRootId ?? deps.message,
    ),
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: DirectConversationPage,
});

function DirectConversationPage() {
  const { agentId } = Route.useParams();
  const agentStatus = useLiveAgent(agentId)?.status.value;
  const { view: requestedView, layout, profile, agentTab } = Route.useSearch();
  const view = useShownConversationTab(requestedView);
  const taskLayout = useTaskLayout(layout);
  const { openAgentProfile, setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const profileAgentId = agentIdFromProfileParam(profile);
  const { page, taskView, conversationProps } = useDirectConversation(agentId);
  const { conversation } = page;
  const { showChat, showTasks, showFiles, changeLayout, openTask, openTaskThread, openMessage } =
    useConversationView(page.ensureLoaded);

  // Opening the DM is reading it — except in the `newest-unread` preference, which keeps
  // unseen messages unread until the latest is actually viewed: the badge clears
  // immediately, but the server-side cursor only advances through `onReadLatest` below.
  const markSeen = useMarkConversationSeen();
  const advanceReadCursor = useServerFn(markDirectConversationRead);
  const readRequiresScroll = useConversationReadRequiresScroll();
  const topLevelEnd = latestTopLevelSequence(conversation.messages);
  useEffect(() => {
    markSeen(agentId, topLevelEnd);
  }, [markSeen, agentId, topLevelEnd]);
  useEffect(() => {
    if (!topLevelEnd || readRequiresScroll) return;
    void persistReadCursor(
      () => advanceReadCursor({ data: { agentId, throughSequence: topLevelEnd } }),
      `agent:${agentId}`,
    );
  }, [advanceReadCursor, agentId, topLevelEnd, readRequiresScroll]);
  const readLatest = (throughSequence: number) => {
    void persistReadCursor(
      () => advanceReadCursor({ data: { agentId, throughSequence } }),
      `agent:${agentId}:latest`,
    );
  };

  if (view === "files")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DirectConversationHeader
          conversation={conversation}
          active="files"
          onShowChat={showChat}
          onShowTasks={showTasks}
          onOpenAgentProfile={openAgentProfile}
        />
        <ConversationFilesPanel
          conversationId={conversation.conversationId}
          onOpenMessage={openMessage}
        />
      </div>
    );
  // The Tasks tab sits in the conversation's main pane, so a Task opened from it shows the
  // conversation's Task popup over the board.
  const tasksPane =
    view === "tasks" ? (
      <TaskBoard
        header={
          <DirectConversationHeader
            conversation={conversation}
            active="tasks"
            onShowChat={showChat}
            onShowFiles={showFiles}
            onOpenAgentProfile={openAgentProfile}
          />
        }
        layout={taskLayout}
        onLayoutChange={changeLayout}
        tasks={taskView.tasks}
        conversationName={conversation.agent.displayName}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate
        loading={taskView.loading}
        error={taskView.error}
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={async (title, idempotencyKey) => {
          const [task] = await taskView.command({ operation: "create", title, idempotencyKey });
          await page.invalidate();
          return task;
        }}
        onCommand={async (command) => {
          await taskView.command(command);
        }}
      />
    ) : undefined;
  return (
    <DirectConversation
      key={conversation.agent.id}
      {...conversationProps}
      tasksPane={tasksPane}
      agentStatus={agentStatus}
      onShowTasks={showTasks}
      onShowFiles={showFiles}
      onReadLatest={readLatest}
      onOpenAgentProfile={openAgentProfile}
      agentProfile={{ agentId: profileAgentId, tab: agentTab }}
      onAgentProfileTabChange={setAgentProfileTab}
      onCloseAgentProfile={closeAgentProfile}
    />
  );
}
