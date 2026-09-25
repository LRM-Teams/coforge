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
import { ConversationTaskBoard } from "#src/features/tasks/conversation-task-board";
import { conversationTaskBoardSearchShape } from "#src/features/tasks/task-board-search";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";
import { ConversationFilesPanel } from "#src/features/conversations/conversation-files";
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
      // The Tasks tab's finished-work window, whose counts the loader reads.
      tasks: search.view === "tasks" ? (search.completed ?? "week") : undefined,
    }) as const,
  remountDeps: ({ params }) => params.channelId,
  loader: async ({ context, params, deps, parentMatchPromise, cause }) => {
    const window = await ensureConversationWindow(
      context.queryClient,
      publicChannelQuery(params.channelId).query,
      deps.threadRootId ?? deps.message,
    );
    const conversationId = window.pages.at(-1)?.conversationId;
    if (deps.tasks && conversationId) {
      const completedWindow = deps.tasks;
      const summary = parentMatchPromise.then(({ loaderData }) =>
        context.queryClient.ensureQueryData(
          finishedSummaryQuery(
            { workspaceId: loaderData?.workspaceId ?? "", conversationId },
            completedWindow,
          ),
        ),
      );
      // Opening the page waits for the counts. Switching to the Tasks tab or changing the window
      // (`stay`) only starts the read: the board waits for it itself (`finished.pending`), so the
      // conversation stays on screen instead of giving way to its loading page.
      if (cause === "stay") void summary.catch(() => undefined);
      else await summary;
    }
    return window;
  },
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelPage,
});

function ChannelPage() {
  const { channelId } = Route.useParams();
  const { view: requestedView, profile, agentTab, ...search } = Route.useSearch();
  const view = useShownConversationTab(requestedView);
  const { openAgentProfile, setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const profileAgentId = agentIdFromProfileParam(profile);
  const { page, taskView, refreshChannelAndSidebar, conversationProps } =
    useChannelConversation(channelId);
  const { conversation } = page;
  const { showChat, showTasks, showFiles, openTask, openTaskThread, openMessage } =
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
      <ConversationTaskBoard
        conversationId={conversation.conversationId}
        header={
          <ChannelConversationHeader
            conversation={conversation}
            active="tasks"
            onShowChat={showChat}
            onShowFiles={showFiles}
            onChanged={refreshChannelAndSidebar}
          />
        }
        search={search}
        taskView={taskView}
        name={`#${conversation.name}`}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate={Boolean(conversation.senderMemberId)}
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={
          conversation.senderMemberId
            ? async (titles, idempotencyKey) => {
                const tasks = await taskView.command({
                  operation: "create",
                  titles,
                  idempotencyKey,
                });
                await page.invalidate();
                return tasks;
              }
            : undefined
        }
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
