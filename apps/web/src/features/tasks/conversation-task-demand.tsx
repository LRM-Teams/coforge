import { memo, useMemo } from "react";
import { and, gte, inArray, lte, useLiveQuery } from "@tanstack/react-db";

import { DEMAND_GC_TIME_MS, messageWindowTasks } from "./conversation-tasks-collection";
import { useConversationTasksCollection } from "./use-conversation-tasks";

/**
 * Reads the Tasks a conversation's messages show, and nothing else: the Tasks of the loaded
 * message window (unless `readWindow` is off: a popup shown alone has no stream), the Tasks the
 * bodies name, and the Task whose popup is open. Each is one live query over the conversation's
 * Tasks collection, whose predicate is the read (TanStack DB on-demand sync), so a window that
 * grows reads once per page and never once per row. It renders nothing; the rows read their Task
 * from the collection's store (`useMessageTask`, `useNumberedTask`).
 */
export function ConversationTaskDemand({
  conversationId,
  messages,
  hasNewer,
  readWindow,
  openTaskNumber,
}: {
  conversationId: string;
  messages: readonly { sequence: number; body: string }[];
  /** Whether the window is pinned in history, with newer messages past its end. */
  hasNewer: boolean;
  readWindow: boolean;
  openTaskNumber: number | undefined;
}) {
  const window = useMemo(() => messageWindowTasks(messages, hasNewer), [messages, hasNewer]);
  // Only what the reads depend on reaches them, so a message that changes none of it (most
  // realtime messages) rebuilds no query.
  return (
    <TaskReads
      conversationId={conversationId}
      sequenceFrom={readWindow ? window?.sequenceFrom : undefined}
      sequenceTo={window?.sequenceTo}
      numbersKey={window?.numbers.join(",") ?? ""}
      openTaskNumber={openTaskNumber}
    />
  );
}

const TaskReads = memo(function TaskReads({
  conversationId,
  sequenceFrom,
  sequenceTo,
  numbersKey,
  openTaskNumber,
}: {
  conversationId: string;
  sequenceFrom: number | undefined;
  sequenceTo: number | undefined;
  numbersKey: string;
  openTaskNumber: number | undefined;
}) {
  const { collection } = useConversationTasksCollection(conversationId);
  const numbers = useMemo(
    () => (numbersKey ? numbersKey.split(",").map(Number) : []),
    [numbersKey],
  );
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
    gcTime: DEMAND_GC_TIME_MS,
  });
  useLiveQuery({
    query: (q) =>
      numbers.length === 0
        ? undefined
        : q.from({ task: collection }).where(({ task }) => inArray(task.number, numbers)),
    gcTime: DEMAND_GC_TIME_MS,
  });
  // The popup's Task may be none of those (a finished one opened from the Tasks tab).
  useLiveQuery({
    query: (q) =>
      openTaskNumber === undefined
        ? undefined
        : q.from({ task: collection }).where(({ task }) => inArray(task.number, [openTaskNumber])),
    gcTime: DEMAND_GC_TIME_MS,
  });
  return null;
});
