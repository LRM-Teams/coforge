import { useMemo, useRef, useState } from "react";
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

/** The oldest loaded top-level message bounds the next page of history. */
const beforeFirstRoot = (messages: PageMessage[]) =>
  messages.find((message) => !message.threadRootId)?.sequence;
/** Channels page from the oldest loaded message of any kind. */
const beforeFirstMessage = (messages: PageMessage[]) => messages[0]?.sequence;

function conversationPages<M extends PageMessage, T extends ConversationPage<M>>(
  queryKey: readonly unknown[],
  loadPage: (page: { beforeSequence?: number }) => Promise<T>,
  olderBefore: (messages: M[]) => number | undefined,
) {
  return infiniteQueryOptions({
    queryKey,
    queryFn: ({ pageParam }) => loadPage({ beforeSequence: pageParam }),
    initialPageParam: undefined as number | undefined,
    // History only grows backwards: pages[0] is the oldest loaded window, the latest is last.
    getPreviousPageParam: (oldest: T) =>
      oldest.hasOlder ? olderBefore(oldest.messages) : undefined,
    getNextPageParam: () => undefined,
  });
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

type Pages<T> = InfiniteData<T, number | undefined>;

/**
 * A message route's conversation, read from the Query cache the loader populated.
 * Older history is more pages of the same infinite query; everything that arrives later
 * (polls, realtime, the user's own sends, an "around" jump) is written into the cache with
 * setQueryData, so every reader of the key sees the same conversation.
 */
export function useConversationQuery<M extends PageMessage, T extends ConversationPage<M>>({
  query,
  loadUpdates,
  onRealtime,
}: {
  query: ReturnType<typeof conversationPages<M, T>>;
  loadUpdates: (afterSequence: number) => Promise<M[]>;
  /** Extra work per realtime event, run alongside reconciliation. */
  onRealtime?: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const { data, hasPreviousPage, fetchPreviousPage, refetch } = useSuspenseInfiniteQuery(query);
  const [reminderRefreshKey, setReminderRefreshKey] = useState(0);
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

  /** Fold freshly received messages into the latest window, unless pinned to an older one. */
  const mergeUpdates = (updates: M[]) =>
    setPages((pages) => {
      const latest = pages.pages.at(-1);
      if (!latest || latest.hasNewer) return pages;
      return {
        ...pages,
        pages: [
          ...pages.pages.slice(0, -1),
          { ...latest, messages: mergeMessages(latest.messages, updates) },
        ],
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
  useConversationRealtime(conversationId, async () => {
    await Promise.all([
      reconciliation.reconcile(),
      onRealtimeRef.current?.(),
      refreshActionCards(),
    ]);
    setReminderRefreshKey((value) => value + 1);
  });

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
    reminderRefreshKey,
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
    /** Leave an "around" window and return to the live end of the conversation. */
    showLatest: async () => {
      await refetch();
    },
    /** Re-read every loaded page after a change the realtime feed does not carry. */
    invalidate: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  };
}
