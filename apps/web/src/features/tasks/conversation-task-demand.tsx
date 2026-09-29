import { useMemo } from "react";
import { and, gte, inArray, lte, useLiveQuery } from "@tanstack/react-db";

import { messageWindowTasks } from "./conversation-tasks-collection";
import { useConversationTasksCollection } from "./use-conversation-tasks";

/**
 * Reads the Tasks a conversation's message stream shows, and nothing else: the Tasks of the loaded
 * message window, the Tasks its bodies name, and the Task whose popup is open. Each is one live
 * query over the conversation's Tasks collection, whose predicate is the read (TanStack DB
 * on-demand sync), so a window that grows reads once per page and never once per row. It renders
 * nothing and is its own component, so a read answering re-renders it alone; the rows read their
 * Task from the collection's store (`useMessageTask`, `useNumberedTask`).
 */
export function ConversationTaskDemand({
  conversationId,
  messages,
  hasNewer,
  openTaskNumber,
}: {
  conversationId: string;
  messages: readonly { sequence: number; body: string }[];
  /** Whether the window is pinned in history, with newer messages past its end. */
  hasNewer: boolean;
  openTaskNumber: number | undefined;
}) {
  const { collection, demandGcTime } = useConversationTasksCollection(conversationId);
  const window = useMemo(() => messageWindowTasks(messages, hasNewer), [messages, hasNewer]);
  const sequenceFrom = window?.sequenceFrom;
  const sequenceTo = window?.sequenceTo;
  const numbers = window?.numbers ?? [];
  useLiveQuery({
    query: (q) =>
      sequenceFrom === undefined
        ? undefined
        : q
            .from({ task: collection })
            .where(({ task }) =>
              sequenceTo === undefined
                ? gte(task.sequence, sequenceFrom)
                : and(gte(task.sequence, sequenceFrom), lte(task.sequence, sequenceTo)),
            ),
    gcTime: demandGcTime,
  });
  useLiveQuery({
    query: (q) =>
      numbers.length === 0
        ? undefined
        : q.from({ task: collection }).where(({ task }) => inArray(task.number, numbers)),
    gcTime: demandGcTime,
  });
  // The popup's Task may be none of those (a finished one opened from the Tasks tab).
  useLiveQuery({
    query: (q) =>
      openTaskNumber === undefined
        ? undefined
        : q.from({ task: collection }).where(({ task }) => inArray(task.number, [openTaskNumber])),
    gcTime: demandGcTime,
  });
  return null;
}
