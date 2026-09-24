import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  ChannelConversation,
  ChannelConversationHeader,
} from "#src/features/conversations/channel-conversation";
import {
  ConversationLoadError,
  ConversationPending,
} from "#src/features/conversations/conversation-pending";
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
  ensureConversationWindow,
  publicChannelQuery,
} from "#src/features/conversations/conversation-queries";
import { useChannelConversation } from "#src/features/conversations/use-conversation-data";
import { markPublicChannelRead } from "#src/features/conversations/channels.functions";
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
import { useEffect } from "react";

export const Route = createFileRoute("/_app/messages/channels/$channelId")({
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
  remountDeps: ({ params }) => params.channelId,
  loader: ({ context, params, deps }) =>
    ensureConversationWindow(
      context.queryClient,
      publicChannelQuery(params.channelId).query,
      deps.threadRootId ?? deps.message,
    ),
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelPage,
});

function ChannelPage() {
  const { channelId } = Route.useParams();
  const { view: requestedView, layout, profile, agentTab } = Route.useSearch();
  const view = useShownConversationTab(requestedView);
  const taskLayout = useTaskLayout(layout);
  const { openAgentProfile, setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const profileAgentId = agentIdFromProfileParam(profile);
  const { page, taskView, refreshChannelAndSidebar, conversationProps } =
    useChannelConversation(channelId);
  const { conversation } = page;
  const { showChat, showTasks, showFiles, changeLayout, openTask, openTaskThread, openMessage } =
    useConversationView(page.ensureLoaded);

  // Opening the channel is reading it — except in the `newest-unread` preference, which keeps
  // unseen messages unread until the latest is actually viewed: the badge clears immediately
  // and every event it already counted is remembered, but the server-side cursor only
  // advances through `onReadLatest` below.
  const markSeen = useMarkConversationSeen();
  const advanceReadCursor = useServerFn(markPublicChannelRead);
  const readRequiresScroll = useConversationReadRequiresScroll();
  const topLevelEnd = latestTopLevelSequence(conversation.messages);
  useEffect(() => {
    markSeen(channelId, topLevelEnd);
  }, [markSeen, channelId, topLevelEnd]);
  useEffect(() => {
    if (!topLevelEnd || !conversation.senderMemberId || readRequiresScroll) return;
    void persistReadCursor(
      () => advanceReadCursor({ data: { channelId, throughSequence: topLevelEnd } }),
      `channel:${channelId}`,
    );
  }, [advanceReadCursor, channelId, topLevelEnd, conversation.senderMemberId, readRequiresScroll]);
  const readLatest = (throughSequence: number) => {
    if (!conversation.senderMemberId) return;
    void persistReadCursor(
      () => advanceReadCursor({ data: { channelId, throughSequence } }),
      `channel:${channelId}:latest`,
    );
  };

  if (view === "files")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChannelConversationHeader
          conversation={conversation}
          active="files"
          onShowChat={showChat}
          onShowTasks={showTasks}
          onChanged={refreshChannelAndSidebar}
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
          <ChannelConversationHeader
            conversation={conversation}
            active="tasks"
            onShowChat={showChat}
            onShowFiles={showFiles}
            onChanged={refreshChannelAndSidebar}
          />
        }
        layout={taskLayout}
        onLayoutChange={changeLayout}
        tasks={taskView.tasks}
        conversationName={`#${conversation.name}`}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate={Boolean(conversation.senderMemberId)}
        loading={taskView.loading}
        error={taskView.error}
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={
          conversation.senderMemberId
            ? async (title, idempotencyKey) => {
                const [task] = await taskView.command({
                  operation: "create",
                  title,
                  idempotencyKey,
                });
                await page.invalidate();
                return task;
              }
            : undefined
        }
        onCommand={async (command) => {
          await taskView.command(command);
        }}
      />
    ) : undefined;
  return (
    <ChannelConversation
      key={channelId}
      {...conversationProps}
      tasksPane={tasksPane}
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
