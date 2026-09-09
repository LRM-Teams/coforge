import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ChannelConversation } from "@/features/conversations/channel-conversation";
import { createConversationReconciler } from "@/features/conversations/conversation-reconciliation";
import { useConversationRealtime } from "@/features/conversations/conversation-realtime-client";
import { loadReminderNotices } from "@/features/conversations/reminder-notices.functions";
import { TaskBoard } from "@/features/tasks/task-board";
import { useConversationTasks } from "@/features/tasks/use-conversation-tasks";
import {
  loadConversationAround,
  loadOwnConversationMessages,
} from "@/features/conversations/conversations.functions";
import {
  loadPublicChannel,
  loadPublicChannelUpdates,
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
  loader: ({ params }) => loadPublicChannel({ data: { channelId: params.channelId } }),
  component: ChannelPage,
});

function ChannelPage() {
  const latestConversation = Route.useLoaderData();
  const [conversation, setConversation] = useState(latestConversation);
  const { channelId } = Route.useParams();
  const { view, layout } = Route.useSearch();
  const router = useRouter();
  const send = useServerFn(sendPublicChannelMessage);
  const join = useServerFn(joinPublicChannel);
  const markRead = useServerFn(markPublicChannelThreadRead);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const setMuted = useServerFn(setPublicChannelMuted);
  const loadChannel = useServerFn(loadPublicChannel);
  const loadAround = useServerFn(loadConversationAround);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const loadUpdates = useServerFn(loadPublicChannelUpdates);
  const loadNotices = useServerFn(loadReminderNotices);
  const [reminderRefreshKey, setReminderRefreshKey] = useState(0);
  const channelIdRef = useRef(channelId);
  const loadUpdatesRef = useRef(loadUpdates);
  const mergeUpdatesRef = useRef<(updates: typeof conversation.messages) => void>(() => {});
  const taskView = useConversationTasks(latestConversation.conversationId);
  channelIdRef.current = channelId;
  loadUpdatesRef.current = loadUpdates;
  mergeUpdatesRef.current = (updates) => {
    setConversation((current) => {
      if (current.hasNewer) return current;
      const messages = new Map(current.messages.map((message) => [message.id, message]));
      for (const message of updates) messages.set(message.id, message);
      return {
        ...current,
        messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence),
      };
    });
  };
  const reconciliation = useMemo(
    () =>
      createConversationReconciler(
        latestConversation.messages.at(-1)?.sequence ?? 0,
        (afterSequence) =>
          loadUpdatesRef.current({
            data: { channelId: channelIdRef.current, afterSequence },
          }),
        (updates) => mergeUpdatesRef.current(updates),
      ),
    [latestConversation.conversationId],
  );
  useConversationRealtime(latestConversation.conversationId, async () => {
    await Promise.all([reconciliation.reconcile(), taskView.refresh()]);
    setReminderRefreshKey((value) => value + 1);
  });

  useEffect(() => {
    setConversation((current) => {
      if (current.conversationId !== latestConversation.conversationId) return latestConversation;
      const messages = new Map(current.messages.map((message) => [message.id, message]));
      for (const message of latestConversation.messages) messages.set(message.id, message);
      return {
        ...latestConversation,
        hasOlder: Boolean(current.hasOlder && latestConversation.hasOlder),
        messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence),
      };
    });
  }, [latestConversation]);

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
  const openTask = async (messageId: string) => {
    if (!conversation.messages.some((message) => message.id === messageId)) {
      const around = await loadAround({
        data: { conversationId: conversation.conversationId, messageId },
      });
      setConversation((current) => ({ ...current, ...around }));
    }
    await router.navigate({
      from: Route.fullPath,
      search: (previous) => ({ ...previous, view: "chat" }),
      hash: `message-${messageId}`,
    });
  };
  if (view === "tasks")
    return (
      <TaskBoard
        layout={layout ?? "board"}
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
                setConversation(await loadChannel({ data: { channelId } }));
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
      reminderRefreshKey={reminderRefreshKey}
      onLoadReminderNotices={async (threadRootId) =>
        (await loadNotices({ data: { conversationId: conversation.conversationId, threadRootId } }))
          .notices
      }
      tasks={taskView.tasks}
      onShowTasks={showTasks}
      onConvertToTask={async (messageId) => {
        await taskView.command({ operation: "convert", messageId });
      }}
      onCreateTask={async (title, requestId, attachmentId) => {
        await taskView.command({ operation: "create", title, requestId, attachmentId });
        setConversation(await loadChannel({ data: { channelId } }));
      }}
      onSend={async (body, requestId, attachmentId, threadRootId) => {
        const message = await send({
          data: { channelId, body, requestId, attachmentId, threadRootId },
        });
        mergeUpdatesRef.current([message]);
        if (threadRootId)
          setConversation((current) => ({
            ...current,
            followedThreadRootIds: current.followedThreadRootIds.includes(threadRootId)
              ? current.followedThreadRootIds
              : [...current.followedThreadRootIds, threadRootId],
          }));
        void reconciliation.reconcile().catch(() => {});
        return message;
      }}
      onJoin={async () => {
        await join({ data: { channelId } });
        await router.invalidate({ sync: true });
      }}
      onMutedChange={async (muted) => {
        await setMuted({ data: { channelId, muted } });
        await router.invalidate({ sync: true });
      }}
      onReadThread={(threadRootId, throughSequence) =>
        markRead({ data: { channelId, threadRootId, throughSequence } })
      }
      onThreadFollowedChange={async (threadRootId, followed) => {
        await setThreadFollowed({ data: { channelId, threadRootId, followed } });
        setConversation((current) => ({
          ...current,
          followedThreadRootIds: followed
            ? [...new Set([...current.followedThreadRootIds, threadRootId])]
            : current.followedThreadRootIds.filter((id) => id !== threadRootId),
        }));
      }}
      onLoadOwnMessages={(beforeSequence) =>
        loadOwnMessages({
          data: { conversationId: conversation.conversationId, beforeSequence },
        })
      }
      onLoadMessageAround={async (messageId) => {
        const around = await loadAround({
          data: { conversationId: conversation.conversationId, messageId },
        });
        setConversation((current) => ({ ...current, ...around }));
      }}
      onShowLatest={async () => {
        const latest = await loadChannel({ data: { channelId } });
        setConversation(latest);
      }}
      onLoadOlder={async () => {
        const beforeSequence = conversation.messages[0]?.sequence;
        if (!beforeSequence) return;
        const older = await loadChannel({
          data: { channelId, beforeSequence },
        });
        setConversation((current) => {
          const messages = new Map(older.messages.map((message) => [message.id, message]));
          for (const message of current.messages) messages.set(message.id, message);
          return {
            ...current,
            hasOlder: older.hasOlder,
            messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence),
          };
        });
      }}
    />
  );
}
