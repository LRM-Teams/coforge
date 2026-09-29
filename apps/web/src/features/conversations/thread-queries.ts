import { queryOptions, useQuery } from "@tanstack/react-query";

import { loadConversationThread } from "./conversations.functions";
import { conversationThreadQueryKey } from "./thread-cache";

/**
 * One thread's replies, read whole when its pane first opens (the window carries only its
 * summary) and kept live from then on: a realtime reply or the viewer's own send is appended to it
 * (`foldThreadReplies`), a reaction or an action card's state is written into it.
 */
export const conversationThreadQuery = (conversationId: string, rootId: string) =>
  queryOptions({
    queryKey: conversationThreadQueryKey(conversationId, rootId),
    queryFn: () => loadConversationThread({ data: { conversationId, threadRootId: rootId } }),
  });

/** A thread's replies, and where their read stands. */
export function useConversationThread(conversationId: string, rootId: string) {
  return useQuery(conversationThreadQuery(conversationId, rootId));
}

/**
 * The newest reply the thread in view holds (0 for none, or until it is read), for marking it
 * read. Reads only that number from the thread's Query, so the reader re-renders when it moves and
 * not for anything else in the thread.
 */
export function useThreadTailSequence(conversationId: string, rootId: string | undefined) {
  const { data } = useQuery({
    ...conversationThreadQuery(conversationId, rootId ?? ""),
    enabled: rootId !== undefined,
    select: (thread) => thread.replies.at(-1)?.sequence ?? 0,
  });
  return data ?? 0;
}
