import { useMemo, useRef } from "react";
import {
  infiniteQueryOptions,
  useQueryClient,
  useSuspenseInfiniteQuery,
  type InfiniteData,
} from "@tanstack/react-query";

import { mergeMessages } from "./conversation-messages";
import { createConversationReconciler } from "./conversation-reconciliation";
import { useConversationRealtime } from "./conversation-realtime-client";
import {
  CONVERSATION_WINDOW_MAX_PAGES,
  CONVERSATION_WINDOW_PAGE_SIZE,
  flushWindowUpdates,
  foldWindowUpdates,
  newestRootSequence,
  nextPageCursor,
  previousPageCursor,
  type ConversationWindowCursor,
} from "@/lib/conversation-window";
import {
  loadConversationAround,
  loadDirectConversation,
  loadDirectConversationUpdates,
} from "./conversations.functions";
import { loadPublicChannel, loadPublicChannelUpdates } from "./channels.functions";
import { loadActionCardStates } from "./action-cards.functions";
import type { ActionCardView } from "./action-card";

type PageMessage = {
  id: string;
  sequence: number;
  threadRootId?: string;
  actionCard?: ActionCardView;
};
type ConversationPage<M extends PageMessage> = {
  conversationId: string;
  hasOlder: boolean;
  hasNewer?: boolean;
  messages: M[];
};

/** One page request: an initial load (no cursor), an older page, or a newer page. */
type PageRequest = {
  beforeSequence?: number;
  afterSequence?: number;
  limit?: number;
};

/** The oldest loaded top-level message bounds the next page of history. */
const beforeFirstRoot = (messages: PageMessage[]) =>
  messages.find((message) => !message.threadRootId)?.sequence;
/** Channels page from the oldest loaded message of any kind. */
const beforeFirstMessage = (messages: PageMessage[]) => messages[0]?.sequence;

function conversationPages<M extends PageMessage, T extends ConversationPage<M>>(
  queryKey: readonly unknown[],
  loadPage: (page: PageRequest) => Promise<T>,
  olderBefore: (messages: M[]) => number | undefined,
) {
  // The bounded window: `maxPages` keeps the loaded pages from growing with every page of history
  // read, dropping the page at the far end from the fetch (see `lib/conversation-window.ts`).
  const query = infiniteQueryOptions({
    queryKey,
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as ConversationWindowCursor;
      return loadPage({
        beforeSequence: cursor?.before,
        afterSequence: cursor?.after,
        limit: CONVERSATION_WINDOW_PAGE_SIZE,
      });
    },
    initialPageParam: undefined as ConversationWindowCursor,
    maxPages: CONVERSATION_WINDOW_MAX_PAGES,
    // Pages[0] is the oldest loaded window, the latest is the live end. Each direction derives its
    // cursor from the boundary page, and an honest `hasNewer` tells whether the newest retained page
    // is still the tail.
    getPreviousPageParam: (oldest: T) => previousPageCursor(oldest, olderBefore(oldest.messages)),
    getNextPageParam: (newest: T) => nextPageCursor(newest, newestRootSequence(newest.messages)),
  });
  /** The newest page on its own, for returning to the live end after the window slid up into
   * history and evicted the tail. */
  const loadInitialPage = () => loadPage({ limit: CONVERSATION_WINDOW_PAGE_SIZE });
  return { query, loadInitialPage };
}

export const directConversationQuery = (agentId: string) =>
  conversationPages(
    ["conversation", "direct", agentId],
    (page) => loadDirectConversation({ data: { agentId, ...page } }),
    beforeFirstRoot,
  );

export const publicChannelQuery = (channelId: string) =>
  conversationPages(
    ["conversation", "channel", channelId],
    (page) => loadPublicChannel({ data: { channelId, ...page } }),
    beforeFirstMessage,
  );

export const directConversationUpdates = (agentId: string) => (afterSequence: number) =>
  loadDirectConversationUpdates({ data: { agentId, afterSequence } });

export const publicChannelUpdates = (channelId: string) => (afterSequence: number) =>
  loadPublicChannelUpdates({ data: { channelId, afterSequence } });

type Pages<T> = InfiniteData<T, ConversationWindowCursor>;

/**
 * A message route's conversation, read from the Query cache the loader populated.
 * Older history is more pages of the same infinite query; everything that arrives later
 * (polls, realtime, the user's own sends, an "around" jump) is written into the cache with
 * setQueryData, so every reader of the key sees the same conversation.
 */
export function useConversationQuery<M extends PageMessage, T extends ConversationPage<M>>({
  query,
  loadInitialPage,
  loadUpdates,
  onRealtime,
}: {
  query: ReturnType<typeof conversationPages<M, T>>["query"];
  /** The newest page on its own: how "back to latest" recovers a tail the window evicted. */
  loadInitialPage: () => Promise<T>;
  loadUpdates: (afterSequence: number) => Promise<M[]>;
  /** Extra work per realtime event, run alongside reconciliation. */
  onRealtime?: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const { data, hasPreviousPage, hasNextPage, fetchPreviousPage, fetchNextPage } =
    useSuspenseInfiniteQuery(query);
  const latestPage = data.pages.at(-1)!;
  const conversationId = latestPage.conversationId;

  const conversation = useMemo(
    () => ({
      ...latestPage,
      hasOlder: hasPreviousPage,
      hasNewer: latestPage.hasNewer ?? false,
      messages: data.pages.reduce<M[]>((all, page) => mergeMessages(all, page.messages), []),
    }),
    [data, hasPreviousPage, latestPage],
  );

  const setPages = (update: (pages: Pages<T>) => Pages<T>) =>
    queryClient.setQueryData<Pages<T>>(query.queryKey, (pages) => (pages ? update(pages) : pages));

  /**
   * Messages the retained window cannot hold yet. While the newest retained page is not the live
   * tail (`hasNewer`), a realtime update must not be folded into it — but dropping it would lose a
   * reply to a root that *is* still retained, because the forward page loader only fetches roots
   * after its cursor and would never fetch that reply. Keep them (deduped by id) and merge them once
   * the tail is back.
   */
  const pendingUpdatesRef = useRef<M[]>([]);

  /** Fold freshly received messages into the latest window, unless pinned to an older one. */
  const mergeUpdates = (updates: M[]) =>
    setPages((pages) => {
      const latest = pages.pages.at(-1);
      const fold = foldWindowUpdates(latest, pendingUpdatesRef.current, updates, mergeMessages);
      if (!fold || !latest) return pages;
      pendingUpdatesRef.current = fold.pending;
      if (!fold.messages) return pages;
      return {
        ...pages,
        pages: [...pages.pages.slice(0, -1), { ...latest, messages: fold.messages }],
      };
    });

  /** Merge anything buffered while the tail was evicted into the newest page, once it is the tail
   * again. Leaves the buffer intact if it is still not (more forward pages remain). */
  const flushPendingUpdates = () =>
    setPages((pages) => {
      const latest = pages.pages.at(-1);
      const messages = flushWindowUpdates(latest, pendingUpdatesRef.current, mergeMessages);
      if (!messages || !latest) return pages;
      pendingUpdatesRef.current = [];
      return {
        ...pages,
        pages: [...pages.pages.slice(0, -1), { ...latest, messages }],
      };
    });

  const loadUpdatesRef = useRef(loadUpdates);
  loadUpdatesRef.current = loadUpdates;
  const mergeUpdatesRef = useRef(mergeUpdates);
  mergeUpdatesRef.current = mergeUpdates;
  const onRealtimeRef = useRef(onRealtime);
  onRealtimeRef.current = onRealtime;

  const reconciliation = useMemo(
    () =>
      createConversationReconciler(
        latestPage.messages.at(-1)?.sequence ?? 0,
        (afterSequence) => loadUpdatesRef.current(afterSequence),
        (updates) => mergeUpdatesRef.current(updates),
      ),
    // A new conversation starts a new reconciler; later pages of the same one keep it.
    [conversationId],
  );
  /** Refreshes just the pending action cards currently shown (ADR 0027 "Commit and cancel"),
   * without re-fetching the whole page; reads the live message list at call time via the closure
   * captured into `reconcileRef` by `useConversationRealtime`. */
  const refreshActionCards = async () => {
    const pendingIds = conversation.messages
      .filter((message) => message.actionCard?.state === "pending")
      .map((message) => message.id);
    if (!pendingIds.length) return;
    const states = await loadActionCardStates({ data: { messageIds: pendingIds } });
    setPages((pages) => ({
      ...pages,
      pages: pages.pages.map((page) => ({
        ...page,
        messages: page.messages.map((message) =>
          states[message.id] ? { ...message, actionCard: states[message.id] } : message,
        ),
      })),
    }));
  };
  useConversationRealtime(
    conversationId,
    async () => {
      await Promise.all([
        reconciliation.reconcile(),
        onRealtimeRef.current?.(),
        refreshActionCards(),
      ]);
    },
    // A membership change stale-dates the composer's @-directory (and plain-@handle
    // resolution); the next render picks the refetched directory up. Inert for DMs.
    () =>
      void queryClient
        .invalidateQueries({ queryKey: ["conversation", "mentionables", conversationId] })
        .catch(() => {}),
  );

  /** Replace the loaded history with a window around one message. */
  const loadMessageAround = async (messageId: string) => {
    const around = await loadConversationAround({ data: { conversationId, messageId } });
    setPages((pages) => ({
      pages: [{ ...pages.pages.at(-1)!, ...around }],
      pageParams: [undefined],
    }));
  };

  return {
    conversation,
    reconciliation,
    mergeUpdates,
    /** Adjust the conversation's own fields (membership flags, follows) without a refetch. */
    patch: (update: (page: T) => T) =>
      setPages((pages) => ({
        ...pages,
        pages: pages.pages.map((page, index) =>
          index === pages.pages.length - 1 ? update(page) : page,
        ),
      })),
    loadMessageAround,
    /** Make sure a message is loaded before navigating to it. */
    ensureLoaded: async (messageId: string) => {
      if (!conversation.messages.some((message) => message.id === messageId))
        await loadMessageAround(messageId);
    },
    loadOlder: async () => {
      if (hasPreviousPage) await fetchPreviousPage();
    },
    /** Fetch the next page towards the live end after the window slid up into history and
     * evicted the tail, then merge anything that arrived while the tail was gone. */
    loadNewer: async () => {
      if (!hasNextPage) return;
      await fetchNextPage();
      flushPendingUpdates();
    },
    /** Leave an "around" window, or a history window whose tail the bounded window evicted, and
     * return to the live end. Replaces the loaded pages with a fresh newest page rather than
     * re-fetching the existing (possibly evicted) window, so the tail really is loaded when this
     * resolves; the pane's pending-latest effect then scrolls to it. */
    showLatest: async () => {
      const newest = await loadInitialPage();
      const buffered = pendingUpdatesRef.current;
      pendingUpdatesRef.current = [];
      queryClient.setQueryData<Pages<T>>(query.queryKey, {
        pages: [
          buffered.length
            ? { ...newest, messages: mergeMessages(newest.messages, buffered) }
            : newest,
        ],
        pageParams: [undefined],
      });
    },
    /** Re-read every loaded page after a change the realtime feed does not carry. */
    invalidate: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  };
}
