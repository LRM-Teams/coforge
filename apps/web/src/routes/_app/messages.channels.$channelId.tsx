import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChannelConversation } from "@/features/conversations/channel-conversation";
import {
  ConversationLoadError,
  ConversationPending,
} from "@/features/conversations/conversation-pending";
import { createConversationReconciler } from "@/features/conversations/conversation-reconciliation";
import { useConversationRealtime } from "@/features/conversations/conversation-realtime-client";
import { loadReminderNotices } from "@/features/conversations/reminder-notices.functions";
import {
  loadConversationAround,
  loadOwnConversationMessages,
} from "@/features/conversations/conversations.functions";
import {
  loadPublicChannel,
  loadPublicChannelUpdates,
  joinPublicChannel,
  setPublicChannelMuted,
  sendPublicChannelMessage,
} from "@/features/conversations/channels.functions";

export const Route = createFileRoute("/_app/messages/channels/$channelId")({
  remountDeps: ({ params }) => params.channelId,
  loader: ({ params }) => loadPublicChannel({ data: { channelId: params.channelId } }),
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelPage,
});

function ChannelPage() {
  const latestConversation = Route.useLoaderData();
  const [conversation, setConversation] = useState(latestConversation);
  const { channelId } = Route.useParams();
  const router = useRouter();
  const send = useServerFn(sendPublicChannelMessage);
  const join = useServerFn(joinPublicChannel);
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
    await reconciliation.reconcile();
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

  return (
    <ChannelConversation
      key={channelId}
      conversation={conversation}
      reminderRefreshKey={reminderRefreshKey}
      onLoadReminderNotices={async () =>
        (await loadNotices({ data: { conversationId: conversation.conversationId } })).notices
      }
      onSend={async (body, requestId, attachmentId) => {
        const message = await send({
          data: { channelId, body, requestId, attachmentId },
        });
        mergeUpdatesRef.current([message]);
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
