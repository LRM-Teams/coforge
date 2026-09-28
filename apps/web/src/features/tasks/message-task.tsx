import { useConversationId } from "#src/features/conversations/conversation-id";
import { TaskBadge } from "./task-board";
import { useMessageTask } from "./use-conversation-tasks";

/**
 * The Task a message became, under the message: its number, status and owner. Inside a
 * conversation it reads that one Task, so a Task's change repaints its own message's badge and no
 * other row; outside one it shows nothing.
 */
export function MessageTask({ messageId }: { messageId: string }) {
  const conversationId = useConversationId();
  return conversationId ? (
    <ConversationMessageTask conversationId={conversationId} messageId={messageId} />
  ) : null;
}

function ConversationMessageTask({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const task = useMessageTask(conversationId, messageId);
  return task ? <TaskBadge task={task} /> : null;
}
