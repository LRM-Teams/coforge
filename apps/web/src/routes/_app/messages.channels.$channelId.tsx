import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  ChannelConversation,
  ChannelConversationHeader,
} from "@/features/conversations/channel-conversation";
import {
  ConversationLoadError,
  ConversationPending,
} from "@/features/conversations/conversation-pending";
import {
  publicChannelQuery,
  publicChannelUpdates,
  useConversationQuery,
} from "@/features/conversations/conversation-queries";
import { useConversationView } from "@/features/conversations/use-conversation-view";
import { TaskBoard } from "@/features/tasks/task-board";
import { useTaskLayout } from "@/features/tasks/task-workflow";
import { useConversationTasks } from "@/features/tasks/use-conversation-tasks";
import { loadOwnConversationMessages } from "@/features/conversations/conversations.functions";
import {
  joinPublicChannel,
  markPublicChannelRead,
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
  setPublicChannelMuted,
  sendPublicChannelMessage,
} from "@/features/conversations/channels.functions";
import {
  agentIdFromProfileParam,
  agentProfileParamSchema,
  agentProfileTabParamSchema,
} from "@/features/agents/profile-panel/profile-panel-search";
import { useOpenAgentProfile } from "@/features/agents/profile-panel/open-agent-profile";
import {
  useConversationReadRequiresScroll,
  useMarkConversationSeen,
} from "@/features/conversations/conversation-navigation";
import { latestTopLevelSequence } from "@/features/conversations/conversation-unread";
import { useEffect } from "react";

export const Route = createFileRoute("/_app/messages/channels/$channelId")({
  validateSearch: z.object({
    view: z.enum(["chat", "tasks"]).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
    message: z.uuid().optional().catch(undefined),
    threadRootId: z.uuid().optional().catch(undefined),
    profile: agentProfileParamSchema,
    agentTab: agentProfileTabParamSchema,
  }),
  remountDeps: ({ params }) => params.channelId,
  loader: ({ context, params }) =>
    context.queryClient.infiniteQuery(publicChannelQuery(params.channelId)),
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelPage,
});

function ChannelPage() {
  const { channelId } = Route.useParams();
  const { view, layout, profile, agentTab } = Route.useSearch();
  const taskLayout = useTaskLayout(layout);
  const { openAgentProfile, setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const profileAgentId = agentIdFromProfileParam(profile);
  const send = useServerFn(sendPublicChannelMessage);
  const join = useServerFn(joinPublicChannel);
  const markRead = useServerFn(markPublicChannelThreadRead);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const setMuted = useServerFn(setPublicChannelMuted);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const page = useConversationQuery({
    query: publicChannelQuery(channelId),
    loadUpdates: publicChannelUpdates(channelId),
    onRealtime: () => taskView.refresh(),
  });
  const { conversation } = page;
  const taskView = useConversationTasks(conversation.conversationId);
  const { router, showChat, showTasks, changeLayout, openTask } = useConversationView(
    page.ensureLoaded,
  );

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
    void advanceReadCursor({ data: { channelId, throughSequence: topLevelEnd } }).catch(() => {});
  }, [advanceReadCursor, channelId, topLevelEnd, conversation.senderMemberId, readRequiresScroll]);
  const readLatest = (throughSequence: number) => {
    if (!conversation.senderMemberId) return;
    void advanceReadCursor({ data: { channelId, throughSequence } }).catch(() => {});
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
  if (view === "tasks")
    return (
      <TaskBoard
        header={
          <ChannelConversationHeader
            conversation={conversation}
            tasks={taskView.tasks}
            active="tasks"
            onShowChat={showChat}
            onMutedChange={changeMuted}
            onLeft={afterLeft}
            onOpenAgentProfile={openAgentProfile}
          />
        }
        layout={taskLayout}
        onLayoutChange={changeLayout}
        tasks={taskView.tasks}
        conversationName={`#${conversation.name}`}
        currentMemberId={conversation.senderMemberId}
        canMutate={Boolean(conversation.senderMemberId)}
        loading={taskView.loading}
        error={taskView.error}
        onOpenMessage={openTask}
        onShowChat={showChat}
        onCreateTask={
          conversation.senderMemberId
            ? async (title, requestId) => {
                const [task] = await taskView.command({ operation: "create", title, requestId });
                await page.invalidate();
                return task;
              }
            : undefined
        }
        onCommand={async (command) => {
          await taskView.command(command);
        }}
      />
    );
  return (
    <ChannelConversation
      key={channelId}
      conversation={conversation}
      tasks={taskView.tasks}
      onShowTasks={showTasks}
      onCreateTask={async (title, requestId, attachmentId) => {
        await taskView.command({ operation: "create", title, requestId, attachmentId });
        await page.invalidate();
      }}
      onSend={async (body, requestId, attachmentIds, threadRootId) => {
        const message = await send({
          data: { channelId, body, requestId, attachmentIds, threadRootId },
        });
        page.mergeUpdates([message]);
        if (threadRootId) followThread(threadRootId);
        void page.reconciliation.reconcile().catch(() => {});
        return message;
      }}
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
      onOpenAgentProfile={openAgentProfile}
      agentProfile={{ agentId: profileAgentId, tab: agentTab }}
      onAgentProfileTabChange={setAgentProfileTab}
      onCloseAgentProfile={closeAgentProfile}
    />
  );
}
