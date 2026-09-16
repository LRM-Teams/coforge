import { createFileRoute } from "@tanstack/react-router";
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
import {
  directConversationQuery,
  directConversationUpdates,
  useConversationQuery,
} from "@/features/conversations/conversation-queries";
import { loadReminderNotices } from "@/features/conversations/reminder-notices.functions";
import { useConversationView } from "@/features/conversations/use-conversation-view";
import { TaskBoard } from "@/features/tasks/task-board";
import { useTaskLayout } from "@/features/tasks/task-workflow";
import { useConversationTasks } from "@/features/tasks/use-conversation-tasks";
import {
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
  loader: ({ context, params }) =>
    context.queryClient.infiniteQuery(directConversationQuery(params.agentId)),
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: DirectConversationPage,
});

function DirectConversationPage() {
  const { agentId } = Route.useParams();
  const agentStatus = useConversationAgentStatus(agentId);
  const { view, layout } = Route.useSearch();
  const taskLayout = useTaskLayout(layout);
  const send = useServerFn(sendDirectConversationMessage);
  const markRead = useServerFn(markDirectThreadRead);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const loadNotices = useServerFn(loadReminderNotices);
  const page = useConversationQuery({
    query: directConversationQuery(agentId),
    loadUpdates: directConversationUpdates(agentId),
    onRealtime: () => taskView.refresh(),
  });
  const { conversation } = page;
  const taskView = useConversationTasks(conversation.conversationId);
  const { showChat, showTasks, changeLayout, openTask } = useConversationView(page.ensureLoaded);

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
        onLayoutChange={changeLayout}
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
          await page.invalidate();
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
      reminderRefreshKey={page.reminderRefreshKey}
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
        await page.invalidate();
      }}
      onSend={async (body, requestId, attachmentId, threadRootId) => {
        const message = await send({
          data: { agentId, requestId, body, attachmentId, threadRootId },
        });
        page.mergeUpdates([message]);
        void page.reconciliation.reconcile().catch(() => {});
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
      onLoadMessageAround={page.loadMessageAround}
      onShowLatest={page.showLatest}
      onLoadOlder={page.loadOlder}
    />
  );
}
