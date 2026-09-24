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
  publicChannelQuery,
  publicChannelUpdates,
  useConversationQuery,
} from "#src/features/conversations/conversation-queries";
import {
  useConversationView,
  useShownConversationTab,
} from "#src/features/conversations/use-conversation-view";
import { CONVERSATION_TABS } from "#src/features/conversations/conversation-tabs";
import { openTaskParamSchema } from "#src/features/conversations/conversation-thread-search";
import { TaskBoard } from "#src/features/tasks/task-board";
import { ConversationFilesPanel } from "#src/features/conversations/conversation-files";
import { useTaskLayout } from "#src/features/tasks/task-workflow";
import { useConversationTasks } from "#src/features/tasks/use-conversation-tasks";
import { loadOwnConversationMessages } from "#src/features/conversations/conversations.functions";
import {
  joinPublicChannel,
  markPublicChannelRead,
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
  setPublicChannelMuted,
  sendPublicChannelMessage,
  toggleChannelMessageReaction,
} from "#src/features/conversations/channels.functions";
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
import { useQueryClient } from "@tanstack/react-query";
import { threadFollowingAgentsQueryPrefix } from "#src/features/conversations/conversation-query-keys";

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
  remountDeps: ({ params }) => params.channelId,
  loader: ({ context, params }) =>
    context.queryClient.infiniteQuery(publicChannelQuery(params.channelId).query),
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelPage,
});

function ChannelPage() {
  const { channelId } = Route.useParams();
  const { view: requestedView, layout, profile, agentTab } = Route.useSearch();
  const view = useShownConversationTab(requestedView);
  const queryClient = useQueryClient();
  const taskLayout = useTaskLayout(layout);
  const { openAgentProfile, setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const profileAgentId = agentIdFromProfileParam(profile);
  const send = useServerFn(sendPublicChannelMessage);
  const toggleReaction = useServerFn(toggleChannelMessageReaction);
  const join = useServerFn(joinPublicChannel);
  const markRead = useServerFn(markPublicChannelThreadRead);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const setMuted = useServerFn(setPublicChannelMuted);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const page = useConversationQuery({
    ...publicChannelQuery(channelId),
    loadUpdates: publicChannelUpdates(channelId),
    onRealtime: () =>
      Promise.all([
        taskView.refresh(),
        queryClient.invalidateQueries({
          queryKey: threadFollowingAgentsQueryPrefix(channelId),
        }),
      ]),
  });
  const { conversation } = page;
  const taskView = useConversationTasks(conversation.conversationId);
  const {
    router,
    showChat,
    showTasks,
    showFiles,
    changeLayout,
    openTask,
    openTaskThread,
    openMessage,
  } = useConversationView(page.ensureLoaded);

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

  // Membership changes reach the sidebar through the layout loader and this page
  // through its query; both are refreshed.
  const changeMuted = async (muted: boolean) => {
    await setMuted({ data: { channelId, muted } });
    await Promise.all([page.invalidate(), router.invalidate({ sync: true })]);
  };
  // The Members dialog calls `leavePublicChannel` itself; this only refreshes the page (so
  // `senderMemberId` empties and the read-only Join view appears) and the sidebar channel list
  // (so it reflects `joined: false`).
  const afterLeft = async () => {
    await Promise.all([page.invalidate(), router.invalidate({ sync: true })]);
  };
  const followThread = (threadRootId: string) =>
    page.patch((current) => ({
      ...current,
      followedThreadRootIds: current.followedThreadRootIds.includes(threadRootId)
        ? current.followedThreadRootIds
        : [...current.followedThreadRootIds, threadRootId],
    }));
  if (view === "files")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChannelConversationHeader
          conversation={conversation}
          active="files"
          onShowChat={showChat}
          onShowTasks={showTasks}
          onMutedChange={changeMuted}
          onLeft={afterLeft}
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
          <ChannelConversationHeader
            conversation={conversation}
            active="tasks"
            onShowChat={showChat}
            onShowFiles={showFiles}
            onMutedChange={changeMuted}
            onLeft={afterLeft}
            onOpenAgentProfile={openAgentProfile}
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
        onShowChat={showChat}
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
      tasksPane={tasksPane}
      conversation={conversation}
      tasks={taskView.tasks}
      onShowTasks={showTasks}
      onShowFiles={showFiles}
      onCreateTask={async (title, idempotencyKey, attachmentId) => {
        await taskView.command({ operation: "create", title, idempotencyKey, attachmentId });
        await page.invalidate();
      }}
      onSend={async (body, requestId, attachmentIds, threadRootId) => {
        const message = await send({
          data: { channelId, requestId, body, attachmentIds, threadRootId },
        });
        page.mergeUpdates([message]);
        if (threadRootId) followThread(threadRootId);
        void page.reconciliation.reconcile().catch(() => {});
        return message;
      }}
      onToggleReaction={(messageId, emoji, active) =>
        page.toggleReaction(
          messageId,
          emoji,
          conversation.viewerHandle ? `@${conversation.viewerHandle}` : undefined,
          active,
          () => toggleReaction({ data: { channelId, messageId, emoji, active } }),
        )
      }
      onJoin={async () => {
        await join({ data: { channelId } });
        await Promise.all([page.invalidate(), router.invalidate({ sync: true })]);
      }}
      onMutedChange={changeMuted}
      onLeft={afterLeft}
      onReadThread={(threadRootId, throughSequence) =>
        markRead({ data: { channelId, threadRootId, throughSequence } })
      }
      onThreadFollowedChange={async (threadRootId, followed) => {
        await setThreadFollowed({ data: { channelId, threadRootId, followed } });
        if (followed) followThread(threadRootId);
        else
          page.patch((current) => ({
            ...current,
            followedThreadRootIds: current.followedThreadRootIds.filter(
              (id) => id !== threadRootId,
            ),
          }));
      }}
      onLoadOwnMessages={(beforeSequence) =>
        loadOwnMessages({
          data: { conversationId: conversation.conversationId, beforeSequence },
        })
      }
      onLoadMessageAround={page.loadMessageAround}
      onShowLatest={page.showLatest}
      onReadLatest={readLatest}
      onLoadOlder={page.loadOlder}
      onLoadNewer={page.loadNewer}
      onOpenAgentProfile={openAgentProfile}
      agentProfile={{ agentId: profileAgentId, tab: agentTab }}
      onAgentProfileTabChange={setAgentProfileTab}
      onCloseAgentProfile={closeAgentProfile}
    />
  );
}
