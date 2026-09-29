import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";

import { mergeMessages } from "./conversation-messages";
import {
  withReply,
  withThreadRead,
  type ThreadReplyInput,
  type ThreadSummary,
  type WindowThreadsPage,
} from "./thread-summary-model";

/**
 * How a conversation's Query cache holds its threads. The window (`useConversationQuery`) holds
 * each root's summary; a thread's replies are their own Query per root, read when its pane opens
 * (`conversationThreadQuery`). Everything that arrives later — a realtime reply, the viewer's own
 * send, a read, a follow — is written into both here, so every reader of either sees the same
 * thread. Each function changes only what its event touches and hands back the objects it left
 * alone: a reply in one thread must not re-render the rest of the window.
 */

/** A thread's replies as its Query holds them. */
export type ThreadReplies<M> = { replies: M[] };

/** One thread's replies: every conversation's threads share the `["conversation","thread",<id>]`
 * prefix. */
export function conversationThreadQueryKey(conversationId: string, rootId: string) {
  return ["conversation", "thread", conversationId, rootId] as const;
}

/** The prefix of every open thread of one conversation. */
export function conversationThreadsQueryKey(conversationId: string) {
  return ["conversation", "thread", conversationId] as const;
}

type WindowPage = WindowThreadsPage & { messages: readonly { id: string }[] };

/** Rewrites the pages that `change` gives a new version, keeping every other page as it is; nothing
 * is written when no page changed. */
function updatePages<P extends WindowPage>(
  queryClient: QueryClient,
  pagesKey: QueryKey,
  change: (page: P, pageIndex: number, pages: readonly P[]) => P,
) {
  const data = queryClient.getQueryData<InfiniteData<P, unknown>>(pagesKey);
  if (!data) return;
  const pages = data.pages.map((page, index) => change(page, index, data.pages));
  if (pages.every((page, index) => page === data.pages[index])) return;
  queryClient.setQueryData<InfiniteData<P, unknown>>(pagesKey, { ...data, pages });
}

const holdsRoot = (page: WindowPage, rootId: string) =>
  page.messages.some((message) => message.id === rootId);

/**
 * A read of the thread that is under way may have been answered before this reply existed, and
 * would then replace the thread without it: it is given up and made again. A thread nothing is
 * reading (its pane closed, its read done) has no read to start over.
 */
function startReadOver(queryClient: QueryClient, key: QueryKey) {
  if (queryClient.getQueryState(key)?.fetchStatus !== "fetching") return;
  const refetch = () =>
    queryClient.refetchQueries(
      { queryKey: key, exact: true, type: "active" },
      { cancelRefetch: true },
    );
  // A thread that holds replies keeps them meanwhile, and the new read takes over the one under
  // way. A first read has nothing to keep and is only started over once it is cancelled.
  if (queryClient.getQueryData(key)) void refetch();
  else void queryClient.cancelQueries({ queryKey: key, exact: true }).then(refetch);
}

/**
 * Replies that arrived (a realtime signal, the viewer's own send) folded into what is loaded. A
 * reply always updates its root's summary, on the page that holds the root: a reply the summary
 * already reflects changes nothing. It also joins the thread's replies when that thread is loaded,
 * and only then: an unopened thread is read whole when its pane opens, and a read under way is
 * started over (`startReadOver`). A reply to a root outside the loaded window has no summary to
 * update.
 */
export function foldThreadReplies<
  M extends ThreadReplyInput & { threadRootId?: string },
  P extends WindowPage,
>(
  queryClient: QueryClient,
  {
    pagesKey,
    conversationId,
    replies,
    viewerIsMember,
  }: { pagesKey: QueryKey; conversationId: string; replies: readonly M[]; viewerIsMember: boolean },
) {
  const byRoot = new Map<string, M[]>();
  for (const reply of replies) {
    if (!reply.threadRootId) continue;
    byRoot.set(reply.threadRootId, [...(byRoot.get(reply.threadRootId) ?? []), reply]);
  }
  if (byRoot.size === 0) return;
  for (const [rootId, group] of byRoot) {
    const key = conversationThreadQueryKey(conversationId, rootId);
    const loaded = queryClient.getQueryData<ThreadReplies<M>>(key);
    if (!loaded) {
      startReadOver(queryClient, key);
      continue;
    }
    queryClient.setQueryData<ThreadReplies<M>>(key, {
      ...loaded,
      replies: mergeMessages(loaded.replies, group),
    });
    // Only a reply the thread did not hold can have been missed by a read under way.
    const held = new Set(loaded.replies.map((each) => each.id));
    if (group.some((reply) => !held.has(reply.id))) startReadOver(queryClient, key);
  }
  updatePages<P>(queryClient, pagesKey, (page) => {
    let threads = page.threads as Record<string, ThreadSummary> | undefined;
    for (const [rootId, group] of byRoot) {
      if (!holdsRoot(page, rootId)) continue;
      const before = threads?.[rootId];
      const after = [...group]
        .sort((left, right) => left.sequence - right.sequence)
        .reduce<ThreadSummary | undefined>(
          (summary, reply) => withReply(summary, reply, { countUnread: viewerIsMember }),
          before,
        );
      if (after && after !== before) threads = { ...threads, [rootId]: after };
    }
    return threads === page.threads ? page : { ...page, threads };
  });
}

/**
 * The viewer read a thread through `throughSequence`: on the page that holds its root, the summary
 * loses its unread mark once that reaches the newest reply, and the cursor moves (never back).
 */
export function applyThreadRead<P extends WindowPage>(
  queryClient: QueryClient,
  {
    pagesKey,
    rootId,
    throughSequence,
  }: { pagesKey: QueryKey; rootId: string; throughSequence: number },
) {
  updatePages<P>(queryClient, pagesKey, (page) => {
    if (!holdsRoot(page, rootId)) return page;
    const summary = page.threads?.[rootId];
    const read = summary && withThreadRead(summary, throughSequence);
    const cursor = Math.max(page.threadReadThrough?.[rootId] ?? 0, throughSequence);
    const cursorMoved = cursor !== page.threadReadThrough?.[rootId];
    if (read === summary && !cursorMoved) return page;
    return {
      ...page,
      ...(read !== summary && { threads: { ...page.threads, [rootId]: read } }),
      ...(cursorMoved && { threadReadThrough: { ...page.threadReadThrough, [rootId]: cursor } }),
    };
  });
}

/**
 * The viewer follows or unfollows a thread: no page lists it afterwards but the one that holds its
 * root (the latest page when the root is not loaded), and only when followed.
 */
export function setThreadFollowed<P extends WindowPage>(
  queryClient: QueryClient,
  { pagesKey, rootId, followed }: { pagesKey: QueryKey; rootId: string; followed: boolean },
) {
  updatePages<P>(queryClient, pagesKey, (page, index, pages) => {
    const holder = pages.findIndex((candidate) => holdsRoot(candidate, rootId));
    const target = holder >= 0 ? holder : pages.length - 1;
    const listed = page.followedThreadRootIds ?? [];
    const shouldList = followed && index === target;
    if (listed.includes(rootId) === shouldList) return page;
    return {
      ...page,
      followedThreadRootIds: shouldList
        ? [...listed, rootId]
        : listed.filter((id) => id !== rootId),
    };
  });
}

/** Every loaded reply of the conversation's open threads. */
export function loadedThreadReplies<M>(queryClient: QueryClient, conversationId: string): M[] {
  return queryClient
    .getQueriesData<ThreadReplies<M>>({ queryKey: conversationThreadsQueryKey(conversationId) })
    .flatMap(([, data]) => data?.replies ?? []);
}

/** Changes one loaded reply (a reaction, an action card's state) in the open thread that holds it;
 * every other thread keeps its very replies. */
export function updateLoadedReply<M extends { id: string }>(
  queryClient: QueryClient,
  conversationId: string,
  messageId: string,
  update: (message: M) => M,
) {
  queryClient.setQueriesData<ThreadReplies<M>>(
    { queryKey: conversationThreadsQueryKey(conversationId) },
    (loaded) =>
      loaded?.replies.some((reply) => reply.id === messageId)
        ? {
            ...loaded,
            replies: loaded.replies.map((reply) =>
              reply.id === messageId ? update(reply) : reply,
            ),
          }
        : loaded,
  );
}
