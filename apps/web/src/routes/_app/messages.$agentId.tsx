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
import { ConversationTaskBoard } from "#src/features/tasks/conversation-task-board";
import { conversationTaskBoardSearchShape } from "#src/features/tasks/task-board-search";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";
import { ConversationFilesPanel } from "#src/features/conversations/conversation-files";
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
    ...conversationTaskBoardSearchShape,
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
      // The Tasks tab's finished counts arrive with the page, as on the Tasks page, so it never
      // shows empty before them.
      tasks: search.view === "tasks" ? (search.completed ?? "week") : undefined,
    }) as const,
  remountDeps: ({ params }) => params.agentId,
  loader: async ({ context, params, deps, parentMatchPromise }) => {
    const window = await ensureConversationWindow(
      context.queryClient,
      directConversationQuery(params.agentId).query,
      deps.threadRootId ?? deps.message,
    );
    const conversationId = window.pages.at(-1)?.conversationId;
    if (deps.tasks && conversationId) {
      const workspaceId = (await parentMatchPromise).loaderData?.workspaceId ?? "";
      await context.queryClient.ensureQueryData(
        finishedSummaryQuery({ workspaceId, conversationId }, deps.tasks),
      );
    }
    return window;
  },
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: DirectConversationPage,
});

function DirectConversationPage() {
  const { agentId } = Route.useParams();
  const agentStatus = useLiveAgent(agentId)?.status.value;
  const { view: requestedView, profile, agentTab, ...search } = Route.useSearch();
  const view = useShownConversationTab(requestedView);
  const { openAgentProfile, setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const profileAgentId = agentIdFromProfileParam(profile);
  const { page, taskView, conversationProps } = useDirectConversation(agentId);
  const { conversation } = page;
  const { showChat, showTasks, showFiles, openTask, openTaskThread, openMessage } =
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
      <ConversationTaskBoard
        conversationId={conversation.conversationId}
        header={
          <DirectConversationHeader
            conversation={conversation}
            active="tasks"
            onShowChat={showChat}
            onShowFiles={showFiles}
            onOpenAgentProfile={openAgentProfile}
          />
        }
        search={search}
        taskView={taskView}
        name={conversation.agent.displayName}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={async (titles, idempotencyKey) => {
          const tasks = await taskView.command({ operation: "create", titles, idempotencyKey });
          await page.invalidate();
          return tasks;
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
