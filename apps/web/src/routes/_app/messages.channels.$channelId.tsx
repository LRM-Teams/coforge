import { createFileRoute, useRouter } from "@tanstack/react-router";
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
import { loadReminderNotices } from "@/features/conversations/reminder-notices.functions";
import { TaskBoard } from "@/features/tasks/task-board";
import { useTaskLayout } from "@/features/tasks/task-workflow";
import { useConversationTasks } from "@/features/tasks/use-conversation-tasks";
import { loadOwnConversationMessages } from "@/features/conversations/conversations.functions";
import {
  joinPublicChannel,
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
  setPublicChannelMuted,
  sendPublicChannelMessage,
} from "@/features/conversations/channels.functions";

export const Route = createFileRoute("/_app/messages/channels/$channelId")({
  validateSearch: z.object({
    view: z.enum(["chat", "tasks"]).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
    message: z.uuid().optional().catch(undefined),
    threadRootId: z.uuid().optional().catch(undefined),
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
  const { view, layout } = Route.useSearch();
  const taskLayout = useTaskLayout(layout);
  const router = useRouter();
  const send = useServerFn(sendPublicChannelMessage);
  const join = useServerFn(joinPublicChannel);
  const markRead = useServerFn(markPublicChannelThreadRead);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const setMuted = useServerFn(setPublicChannelMuted);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const loadNotices = useServerFn(loadReminderNotices);
  const page = useConversationQuery({
    query: publicChannelQuery(channelId),
    loadUpdates: publicChannelUpdates(channelId),
    onRealtime: () => taskView.refresh(),
  });
  const { conversation } = page;
  const taskView = useConversationTasks(conversation.conversationId);

  const showChat = () =>
    void router.navigate({
      from: Route.fullPath,
      search: (previous) => ({ ...previous, view: "chat" }),
    });
  const showTasks = () =>
    void router.navigate({
      from: Route.fullPath,
      search: (previous) => ({ ...previous, view: "tasks" }),
    });
  // Membership changes reach the sidebar through the layout loader and this page
  // through its query; both are refreshed.
  const changeMuted = async (muted: boolean) => {
    await setMuted({ data: { channelId, muted } });
    await Promise.all([page.invalidate(), router.invalidate({ sync: true })]);
  };
  const openTask = async (messageId: string) => {
    await page.ensureLoaded(messageId);
    await router.navigate({
      from: Route.fullPath,
      search: (previous) => ({ ...previous, view: "chat" }),
      hash: `message-${messageId}`,
    });
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
          />
        }
        layout={taskLayout}
        onLayoutChange={(nextLayout) =>
          void router.navigate({
            from: Route.fullPath,
            search: (previous) => ({ ...previous, layout: nextLayout }),
          })
        }
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
      reminderRefreshKey={page.reminderRefreshKey}
      onLoadReminderNotices={async (threadRootId) =>
        (await loadNotices({ data: { conversationId: conversation.conversationId, threadRootId } }))
          .notices
      }
      tasks={taskView.tasks}
      onShowTasks={showTasks}
      onCreateTask={async (title, requestId, attachmentId) => {
        await taskView.command({ operation: "create", title, requestId, attachmentId });
        await page.invalidate();
      }}
      onSend={async (body, requestId, attachmentId, threadRootId) => {
        const message = await send({
          data: { channelId, body, requestId, attachmentId, threadRootId },
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
      onLoadOlder={page.loadOlder}
    />
  );
}
