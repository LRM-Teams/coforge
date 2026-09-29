import type { ComponentPropsWithoutRef } from "react";

import { useConversationId } from "#src/features/conversations/conversation-id";
import { chipControl } from "#src/lib/chip-control";
import { cn } from "#src/lib/utils";
import { TaskNumberBadge, statusLabel } from "./task-status-icon";
import { useNumberedTask } from "./use-conversation-tasks";

type TaskReferenceProps = ComponentPropsWithoutRef<"span"> & {
  number: number;
  /** Opens the Task's detail popup; absent, a known Task's badge is not a control. */
  onOpenTask?: (number: number) => void;
};

/**
 * A task reference in a message body. Inside a conversation it reads its own Task, so a Task's
 * change repaints its references alone; outside one, or for a number the conversation has no Task
 * for, it stays the words `task #N` (`children`).
 */
export function TaskReference({ number, onOpenTask, children, ...props }: TaskReferenceProps) {
  const conversationId = useConversationId();
  if (!conversationId) return <span {...props}>{children}</span>;
  return (
    <ConversationTaskReference
      {...props}
      conversationId={conversationId}
      number={number}
      onOpenTask={onOpenTask}
    >
      {children}
    </ConversationTaskReference>
  );
}

function ConversationTaskReference({
  conversationId,
  number,
  onOpenTask,
  children,
  ...props
}: TaskReferenceProps & { conversationId: string }) {
  const task = useNumberedTask(conversationId, number);
  if (!task) return <span {...props}>{children}</span>;
  const control = chipControl(onOpenTask && (() => onOpenTask(number)));
  return (
    <span
      {...props}
      {...control}
      // The ring is decorative, so the status is spelled out in the chip's name.
      aria-label={`task #${number}, ${statusLabel(task.status)}`}
      data-task-status={task.status}
      // A badge that opens its Task is a control: the pointer, hover and focus ring of one.
      className={cn(
        "inline-block rounded-md align-middle",
        control &&
          "cursor-pointer hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
      )}
    >
      <TaskNumberBadge number={number} status={task.status} />
    </span>
  );
}
