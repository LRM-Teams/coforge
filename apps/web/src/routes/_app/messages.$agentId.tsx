import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { DirectConversation } from "@/features/conversations/direct-conversation";
import {
  ConversationLoadError,
  ConversationPending,
} from "@/features/conversations/conversation-pending";
import { useConversationAgentStatus } from "@/features/conversations/conversation-layout";
import { createConversationReconciler } from "@/features/conversations/conversation-reconciliation";
import { useConversationRealtime } from "@/features/conversations/conversation-realtime-client";
import { loadReminderNotices } from "@/features/conversations/reminder-notices.functions";
import {
  loadConversationAround,
  loadDirectConversation,
  loadDirectConversationUpdates,
  loadOwnConversationMessages,
  markDirectThreadRead,
  sendDirectConversationMessage,
} from "@/features/conversations/conversations.functions";

export const Route = createFileRoute("/_app/messages/$agentId")({
  remountDeps: ({ params }) => params.agentId,
  loader: ({ params }) => loadDirectConversation({ data: { agentId: params.agentId } }),
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: DirectConversationPage,
});

function DirectConversationPage() {
  const latestConversation = Route.useLoaderData();
  const [conversation, setConversation] = useState(latestConversation);
  const agentStatus = useConversationAgentStatus();
  const { agentId } = Route.useParams();
  const send = useServerFn(sendDirectConversationMessage);
  const markRead = useServerFn(markDirectThreadRead);
  const loadConversation = useServerFn(loadDirectConversation);
  const loadAround = useServerFn(loadConversationAround);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const loadUpdates = useServerFn(loadDirectConversationUpdates);
  const loadNotices = useServerFn(loadReminderNotices);
  const [reminderRefreshKey, setReminderRefreshKey] = useState(0);
  const agentIdRef = useRef(agentId);
  const loadUpdatesRef = useRef(loadUpdates);
  const mergeUpdatesRef = useRef<(updates: typeof conversation.messages) => void>(() => {});
  agentIdRef.current = agentId;
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
            data: { agentId: agentIdRef.current, afterSequence },
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
    <DirectConversation
      key={conversation.agent.id}
      conversation={conversation}
      agentStatus={agentStatus}
      reminderRefreshKey={reminderRefreshKey}
      onLoadReminderNotices={async (threadRootId) =>
        (
          await loadNotices({
            data: { conversationId: conversation.conversationId, threadRootId },
          })
        ).notices
      }
      onSend={async (body, requestId, attachmentId, threadRootId) => {
        const message = await send({
          data: { agentId, requestId, body, attachmentId, threadRootId },
        });
        mergeUpdatesRef.current([message]);
        void reconciliation.reconcile().catch(() => {});
        return message;
      }}
      onReadThread={(threadRootId, throughSequence) =>
        markRead({ data: { agentId, threadRootId, throughSequence } })
      }
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
        const latest = await loadConversation({ data: { agentId } });
        setConversation(latest);
      }}
      onLoadOlder={async () => {
        const beforeSequence = conversation.messages.find(
          (message) => !message.threadRootId,
        )?.sequence;
        if (!beforeSequence) return;
        const older = await loadConversation({
          data: { agentId, beforeSequence },
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
