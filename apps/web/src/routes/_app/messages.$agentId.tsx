import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  DirectConversation,
  DirectConversationHeader,
} from "@/features/conversations/direct-conversation";
import {
  ConversationLoadError,
  ConversationPending,
} from "@/features/conversations/conversation-pending";
import { useConversationAgentStatus } from "@/features/conversations/conversation-layout";
import { createConversationReconciler } from "@/features/conversations/conversation-reconciliation";
import { useConversationRealtime } from "@/features/conversations/conversation-realtime-client";
import { loadReminderNotices } from "@/features/conversations/reminder-notices.functions";
import { TaskBoard } from "@/features/tasks/task-board";
import { useTaskLayout } from "@/features/tasks/task-workflow";
import { useConversationTasks } from "@/features/tasks/use-conversation-tasks";
import {
  loadConversationAround,
  loadDirectConversation,
  loadDirectConversationUpdates,
  loadOwnConversationMessages,
  markDirectThreadRead,
  sendDirectConversationMessage,
} from "@/features/conversations/conversations.functions";

export const Route = createFileRoute("/_app/messages/$agentId")({
  validateSearch: z.object({
    view: z.enum(["chat", "tasks"]).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
    message: z.uuid().optional().catch(undefined),
    threadRootId: z.uuid().optional().catch(undefined),
  }),
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
  const { agentId } = Route.useParams();
  const agentStatus = useConversationAgentStatus(agentId);
  const { view, layout } = Route.useSearch();
  const taskLayout = useTaskLayout(layout);
  const router = useRouter();
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
  const taskView = useConversationTasks(latestConversation.conversationId);
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
        header={
          <DirectConversationHeader
            conversation={conversation}
            tasks={taskView.tasks}
            active="tasks"
            onShowChat={showChat}
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
        conversationName={conversation.agent.displayName}
        currentMemberId={conversation.senderMemberId}
        canMutate
        loading={taskView.loading}
        error={taskView.error}
        onOpenMessage={openTask}
        onShowChat={showChat}
        onCreateTask={async (title, requestId) => {
          const [task] = await taskView.command({ operation: "create", title, requestId });
          setConversation(await loadConversation({ data: { agentId } }));
          return task;
        }}
        onCommand={async (command) => {
          await taskView.command(command);
        }}
      />
    );
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
      tasks={taskView.tasks}
      onShowTasks={showTasks}
      onCreateTask={async (title, requestId, attachmentId) => {
        await taskView.command({ operation: "create", title, requestId, attachmentId });
        setConversation(await loadConversation({ data: { agentId } }));
      }}
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
