import { queryOptions } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { createCollection, createOptimisticAction } from "@tanstack/react-db";
import type { PendingMutation, Transaction } from "@tanstack/react-db";
import {
  queryCollectionOptions,
  UpdateOperationItemNotFoundError,
} from "@tanstack/query-db-collection";

import { assertBrowserOnly } from "#src/lib/browser-only";
import { nextPinOrder, pinOrdersAfterArrange } from "#src/lib/pin-order";
import {
  listPublicChannels,
  setPublicConversationHidden,
  setPublicConversationPinned,
  setPublicConversationUnread,
  type listChannelNames,
} from "./channels.functions";
import {
  loadDirectConversationBadges,
  loadDirectConversationPreferences,
  setDirectConversationHidden,
  setDirectConversationPinned,
  setDirectConversationUnread,
} from "./conversations.functions";
import { arrangePinnedConversations } from "./conversation-pins.functions";
import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "./conversation-query-keys";
import {
  channelRowKey,
  directRowKey,
  pinOfRowKey,
  rowKeyOf,
  type PinRef,
} from "./pinned-conversations";
import { directRowsOf, type DirectRow } from "./sidebar-rows";
import { channelNamesAfter, type ChannelSignal } from "./channel-signals";
import type { ChatList } from "./conversation-unread";
import { savedMessagesQueryKey } from "./saved-messages-collection";
import {
  olderStreamPositions,
  type StreamPosition,
  type StreamPositions,
} from "#src/features/realtime/subscription-gap";

// The Chat sidebar's channel and DM lists as TanStack DB collections, and the changes made to them
// from the sidebar. How they fit with the Query cache and SSR: `features/conversations/AGENTS.md`.

type ChannelList = Awaited<ReturnType<typeof listPublicChannels>>;
/** What one read of every channel's name holds: the names and the stream position they stand at. */
type ChannelNamesRead = Awaited<ReturnType<typeof listChannelNames>>;
type DirectPreferences = Awaited<ReturnType<typeof loadDirectConversationPreferences>>;
type DirectBadges = Awaited<ReturnType<typeof loadDirectConversationBadges>>;
export type Arrangement = { pins: readonly PinRef[]; unpinned: readonly PinRef[] };

/** The server calls the sidebar makes; tests pass their own. */
export type SidebarApi = {
  listChannels: () => Promise<ChannelList>;
  loadDirectPreferences: () => Promise<DirectPreferences>;
  loadDirectBadges: () => Promise<DirectBadges>;
  pin: (target: PinRef, pinned: boolean) => Promise<unknown>;
  markUnread: (target: PinRef) => Promise<unknown>;
  close: (target: PinRef) => Promise<unknown>;
  arrange: (arrangement: Arrangement) => Promise<unknown>;
};

export const serverSidebarApi: SidebarApi = {
  listChannels: () => listPublicChannels(),
  loadDirectPreferences: () => loadDirectConversationPreferences(),
  loadDirectBadges: () => loadDirectConversationBadges(),
  pin: (target, pinned) =>
    target.kind === "channel"
      ? setPublicConversationPinned({ data: { channelId: target.channelId, pinned } })
      : setDirectConversationPinned({ data: { conversationId: target.conversationId, pinned } }),
  markUnread: (target) =>
    target.kind === "channel"
      ? setPublicConversationUnread({ data: { channelId: target.channelId, unread: true } })
      : setDirectConversationUnread({
          data: { conversationId: target.conversationId, unread: true },
        }),
  close: (target) =>
    target.kind === "channel"
      ? setPublicConversationHidden({ data: { channelId: target.channelId, hidden: true } })
      : setDirectConversationHidden({
          data: { conversationId: target.conversationId, hidden: true },
        }),
  arrange: (arrangement) =>
    arrangePinnedConversations({
      data: { pins: [...arrangement.pins], unpinned: [...arrangement.unpinned] },
    }),
};

/**
 * The channel list (shown in `compareChannelNames` order, the server's), when it was read, and the
 * signal channels' stream positions it was read at (`readAfterStreamPositions`): a direct write to
 * the cache keeps `fetchedAt` and the positions, so only a server read changes them.
 */
function fetchChannels(api: SidebarApi) {
  return async () => {
    const { streamPositions, channels } = await api.listChannels();
    return { fetchedAt: Date.now(), rows: channels, streamPositions };
  };
}

export type ChannelRow = Awaited<ReturnType<ReturnType<typeof fetchChannels>>>["rows"][number];

/**
 * The DM rows, the viewer's id, and the stream positions the list stands at: per signal channel the
 * older of its two reads' (`olderStreamPositions`), since it may lack what either did. A re-read
 * fails as a whole, so the list keeps the rows it has; only a first load (`tolerant`) falls back per
 * read, as the page always has: rows without pins or badges, no viewer id (so no personal signal
 * channel keyed by an empty id), and no positions.
 */
function fetchDirects(api: SidebarApi, { tolerant }: { tolerant: boolean }) {
  return async () => {
    let partial = false;
    const fallBack =
      <T>(fallback: T) =>
      () => {
        partial = true;
        return fallback;
      };
    const [preferences, badges] = await Promise.all([
      tolerant
        ? api
            .loadDirectPreferences()
            .catch(fallBack({ conversations: [], pinned: [], hidden: [], streamPositions: {} }))
        : api.loadDirectPreferences(),
      tolerant
        ? api.loadDirectBadges().catch(fallBack({ viewerId: "", unread: {}, streamPositions: {} }))
        : api.loadDirectBadges(),
    ]);
    return {
      fetchedAt: Date.now(),
      viewerId: badges.viewerId || undefined,
      rows: directRowsOf(preferences, badges.unread),
      streamPositions: olderStreamPositions(preferences.streamPositions, badges.streamPositions),
      /** A read fell back: the list is read again on the next navigation. */
      partial,
    };
  };
}

// The lists follow the member's own changes and realtime; a returning tab does not re-read them.
const LIST_OPTIONS = { refetchOnWindowFocus: false } as const;

export const sidebarChannelsQuery = (workspaceId: string, api: SidebarApi = serverSidebarApi) =>
  queryOptions({
    queryKey: sidebarChannelsQueryKey(workspaceId),
    queryFn: fetchChannels(api),
    ...LIST_OPTIONS,
  });

/** The DM rows. `tolerant` only for a first load, when there are no rows yet to keep. */
export const sidebarDirectsQuery = (
  workspaceId: string,
  { tolerant = false, api = serverSidebarApi }: { tolerant?: boolean; api?: SidebarApi } = {},
) =>
  queryOptions({
    queryKey: sidebarDirectsQueryKey(workspaceId),
    queryFn: fetchDirects(api, { tolerant }),
    ...LIST_OPTIONS,
  });

/**
 * How fresh a Chat list the layout's loader reads must be: a hover preload reuses whatever is
 * cached; any other load reads only a list not cached or marked stale, since the page keeps the
 * lists live through realtime and re-reads them when a subscribe may have missed something
 * (`listsMissedBySubscribe`).
 */
export function chatListStaleTime(cause: "preload" | "enter" | "stay") {
  return cause === "preload" ? ("static" as const) : Infinity;
}

/**
 * The chat layout's read of the sidebar's two lists into the Query cache, which the sidebar reads
 * until its collections are ready (see `chatListStaleTime`). A first load has no DM rows to keep, so
 * each of its reads falls back on its own; a later one that fails keeps the rows the sidebar has.
 */
export async function loadSidebarLists(
  queryClient: QueryClient,
  workspaceId: string,
  cause: "preload" | "enter" | "stay",
  api: SidebarApi = serverSidebarApi,
) {
  const staleTime = chatListStaleTime(cause);
  const firstLoad = queryClient.getQueryData(sidebarDirectsQueryKey(workspaceId)) === undefined;
  const directs = queryClient.query({
    ...sidebarDirectsQuery(workspaceId, { tolerant: firstLoad, api }),
    staleTime,
  });
  await Promise.all([
    queryClient.query({ ...sidebarChannelsQuery(workspaceId, api), staleTime }),
    firstLoad ? directs : directs.catch(() => undefined),
  ]);
  const directsKey = sidebarDirectsQueryKey(workspaceId);
  if (queryClient.getQueryData<{ partial: boolean }>(directsKey)?.partial)
    await queryClient.invalidateQueries({ queryKey: directsKey, refetchType: "none" });
}

/**
 * Whether every channel's name (`channelNamesQuery`) is behind the channel list just read: a listed
 * channel it lacks, or one renamed since. The names cover closed and archived channels too, so a
 * shorter list is not behind. A page that was away from Chat misses the channel signals, so the
 * chat loader re-reads the names when this says so.
 */
export function channelNamesBehind(
  names: readonly { id: string; name: string }[],
  channels: readonly { id: string; name: string }[],
): boolean {
  const byId = new Map(names.map((channel) => [channel.id, channel.name]));
  return channels.some((channel) => byId.get(channel.id) !== channel.name);
}

/** The Query each Chat list is read into. Every one's data carries `streamPositions`, where its
 * last server read stood in the signal channels that keep it live (`readAfterStreamPositions`). */
export const chatListQueryKey: Record<ChatList, (workspaceId: string) => readonly unknown[]> = {
  channels: sidebarChannelsQueryKey,
  dms: sidebarDirectsQueryKey,
  channelNames: channelNamesQueryKey,
  saved: savedMessagesQueryKey,
};

/** Resolves once no read of `queryKey` is under way. */
function readSettled(queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> {
  const reading = () => queryClient.isFetching({ queryKey }) > 0;
  if (!reading()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (reading()) return;
      unsubscribe();
      resolve();
    });
  });
}

/**
 * Where a list's last server read stands in a signal channel's stream, for
 * `rereadMissedBySubscribe`; undefined when the read had no position for that channel (Centrifugo
 * unavailable, a stream reset between the reads of a DM list, a fallen-back first load), which
 * means the list is re-read. A read under way settles first, so a subscribe that lands
 * during the chat loader's read, or during the refetch of a stored copy, is judged by that read
 * instead of re-reading over it.
 */
export async function listReadPosition(
  queryClient: QueryClient,
  workspaceId: string,
  list: ChatList,
  channel: string,
): Promise<StreamPosition | undefined> {
  const queryKey = chatListQueryKey[list](workspaceId);
  await readSettled(queryClient, queryKey);
  return queryClient.getQueryData<{ streamPositions?: StreamPositions }>(queryKey)
    ?.streamPositions?.[channel];
}

/** The fields of a row that a sidebar change touches, named alike on channel and DM rows. */
type SidebarFields = {
  pinned: boolean;
  pinSortOrder: number | null;
  unreadCount: number;
  hidden: boolean;
};

/**
 * The sidebar's two collections, over the same Query keys the loader fills, and the changes a
 * member makes from the sidebar. Each change shows at once and resolves when saved; it rejects
 * when the save failed, by which time the rows are back as they were.
 */
export function createSidebar(
  queryClient: QueryClient,
  workspaceId: string,
  api: SidebarApi = serverSidebarApi,
) {
  assertBrowserOnly("The Chat sidebar's collections");
  const channels = createCollection(
    queryCollectionOptions({
      id: `sidebar-channels:${workspaceId}`,
      queryKey: sidebarChannelsQueryKey(workspaceId),
      queryFn: fetchChannels(api),
      queryClient,
      getKey: (row: ChannelRow) => row.id,
      select: (data) => data.rows,
      ...LIST_OPTIONS,
    }),
  );
  const directs = createCollection(
    queryCollectionOptions({
      id: `sidebar-directs:${workspaceId}`,
      queryKey: sidebarDirectsQueryKey(workspaceId),
      queryFn: fetchDirects(api, { tolerant: false }),
      queryClient,
      getKey: (row: DirectRow) => row.conversationId,
      select: (data) => data.rows,
      ...LIST_OPTIONS,
    }),
  );

  /** Changes one row on screen; a row that has left the list meanwhile is left alone. */
  const edit = (target: PinRef, change: (row: SidebarFields) => void) => {
    if (target.kind === "channel") {
      if (channels.has(target.channelId)) channels.update(target.channelId, change);
    } else if (directs.has(target.conversationId)) directs.update(target.conversationId, change);
  };
  /** Keeps a saved change as shown: its fields are written into the synced list, so it does not
   * depend on a later re-read. A row the list has dropped meanwhile has nothing to keep. */
  const confirm = (transaction: Transaction) => {
    const write = (mutation: PendingMutation) => {
      const key = String(mutation.key);
      if (mutation.collection.id === channels.id)
        channels.utils.writeUpdate({ ...mutation.changes, id: key });
      else directs.utils.writeUpdate({ ...mutation.changes, conversationId: key });
    };
    for (const mutation of transaction.mutations) {
      try {
        write(mutation);
      } catch (error) {
        // The row is no longer in the synced list: the next read shows the list as it is.
        if (!(error instanceof UpdateOperationItemNotFoundError)) throw error;
      }
    }
  };
  const allPinOrders = () =>
    [...channels.toArray, ...directs.toArray].map((row) => (row.pinned ? row.pinSortOrder : null));
  const reread = (target: PinRef) =>
    void (target.kind === "channel" ? channels.utils.refetch() : directs.utils.refetch());

  const pin = createOptimisticAction<{ target: PinRef; pinned: boolean }>({
    onMutate: ({ target, pinned }) => {
      const order = nextPinOrder(allPinOrders());
      edit(target, (row) => {
        if (row.pinned === pinned) return;
        row.pinned = pinned;
        row.pinSortOrder = pinned ? order : null;
      });
    },
    mutationFn: async ({ target, pinned }, { transaction }) => {
      await api.pin(target, pinned);
      confirm(transaction);
    },
  });

  // The badge shows at least one at once; the re-read afterwards brings the server's count, which
  // stays zero when only the viewer has spoken.
  const markUnreadAtOnce = createOptimisticAction<PinRef>({
    onMutate: (target) =>
      edit(target, (row) => {
        row.unreadCount = Math.max(1, row.unreadCount);
      }),
    mutationFn: async (target, { transaction }) => {
      await api.markUnread(target);
      confirm(transaction);
      reread(target);
    },
  });

  const close = createOptimisticAction<PinRef>({
    onMutate: (target) =>
      edit(target, (row) => {
        row.hidden = true;
      }),
    mutationFn: async (target, { transaction }) => {
      await api.close(target);
      confirm(transaction);
    },
  });

  // Drags are saved one after another, in the order they were made: two saves in flight could
  // otherwise reach the server in either order and the older layout win.
  let arranging: Promise<unknown> = Promise.resolve();
  const arrange = createOptimisticAction<Arrangement>({
    onMutate: (arrangement) => {
      const pinned = [
        ...channels.toArray.flatMap((row) =>
          row.pinned ? [{ key: channelRowKey(row.id), row }] : [],
        ),
        ...directs.toArray.flatMap((row) =>
          row.pinned ? [{ key: directRowKey(row.conversationId), row }] : [],
        ),
      ];
      const orders = pinOrdersAfterArrange(
        pinned.map(({ key, row }) => ({ key, order: row.pinSortOrder ?? 0 })),
        { pins: arrangement.pins.map(rowKeyOf), unpinned: arrangement.unpinned.map(rowKeyOf) },
      );
      for (const [key, order] of orders)
        edit(pinOfRowKey(key), (row) => {
          if (row.pinSortOrder === order && row.pinned === (order !== null)) return;
          row.pinned = order !== null;
          row.pinSortOrder = order;
        });
    },
    mutationFn: async (arrangement, { transaction }) => {
      await saveArrangement(arrangement);
      confirm(transaction);
    },
  });
  function saveArrangement(arrangement: Arrangement) {
    const save = arranging.then(() => api.arrange(arrangement));
    arranging = save.catch(() => undefined);
    return save;
  }

  /** Settles when the change is saved. A change with nothing to show first (the lists have not
   * loaded on this page, the row has left them, or it already shows the change) makes an empty
   * transaction, which TanStack DB never saves: that one goes straight to the server, and the
   * lists it touches are marked stale, so the next page to show them reads them again. */
  const saved = (
    transaction: Transaction,
    save: () => Promise<unknown>,
    stale: readonly QueryKey[],
  ) =>
    (transaction.mutations.length > 0
      ? pending(transaction.isPersisted.promise)
      : save().then(() => {
          for (const queryKey of stale) void queryClient.invalidateQueries({ queryKey });
        })
    ).then(() => {});
  /** Changes shown but not yet saved. A failed save's rollback also undoes any direct write made
   * to the lists meanwhile, so `applyChannelSignal` does not write while one is pending. */
  let unsaved = 0;
  const pending = (persisted: Promise<unknown>) => {
    unsaved += 1;
    return persisted.finally(() => {
      unsaved -= 1;
    });
  };
  const channelsKey = sidebarChannelsQueryKey(workspaceId);
  const directsKey = sidebarDirectsQueryKey(workspaceId);
  const listOf = (target: PinRef) => [target.kind === "channel" ? channelsKey : directsKey];
  const actions = {
    setPinned: (target: PinRef, pinned: boolean) =>
      saved(pin({ target, pinned }), () => api.pin(target, pinned), listOf(target)),
    markUnread: (target: PinRef) =>
      saved(markUnreadAtOnce(target), () => api.markUnread(target), listOf(target)),
    close: (target: PinRef) => saved(close(target), () => api.close(target), listOf(target)),
    arrange: (arrangement: Arrangement) =>
      saved(arrange(arrangement), () => saveArrangement(arrangement), [channelsKey, directsKey]),
  };
  /**
   * Applies a channel created, changed or gone anywhere in the Workspace to the synced list, with
   * no read: a new channel is listed as one the viewer has not joined (their own join arrives as
   * a `ViewerEvent`), and a changed one takes its new name and archived state and keeps the
   * viewer's place in it. False when the list cannot place it and must be read again: it has not
   * synced yet, a sidebar change is still being saved (whose rollback, if the save fails, would
   * undo a direct write too), the event names only ids, or it is a channel the list has never
   * heard of coming back (`#general` restored, whose place for the viewer the event does not
   * carry). `known`: every channel's name has it, so a channel the list leaves out on purpose
   * (closed) stays out.
   */
  const applyChannelSignal = (signal: ChannelSignal, { known }: { known: boolean }): boolean => {
    if (channels.status !== "ready" || unsaved > 0) return false;
    const id = signal.conversationId;
    if (signal.type === "channel.updated.v1" && signal.gone) {
      if (channels.has(id)) channels.utils.writeDelete(id);
      return true;
    }
    if (!signal.channel) return false;
    const { name, archived } = signal.channel;
    if (channels.has(id)) channels.utils.writeUpdate({ id, name, archived });
    else if (signal.type === "channel.created.v1")
      channels.utils.writeInsert({
        id,
        name,
        joined: false,
        archived,
        muted: false,
        unreadCount: 0,
        hidden: false,
        pinned: false,
        pinSortOrder: null,
      });
    else return known;
    return true;
  };

  return { channels, directs, actions, applyChannelSignal };
}

export type Sidebar = ReturnType<typeof createSidebar>;

/**
 * Applies a channel created, changed or gone anywhere in the Workspace to every channel's name and
 * to the channel list from the event alone, as Slack's clients apply `channel_created`, and returns
 * the lists still to re-read: one the event cannot place (an older server's ids-only event,
 * `#general` coming back, a sidebar not yet hydrated or synced), and one whose read was already
 * under way, whose older answer would otherwise land over the event.
 */
export function applyChannelSignalToLists(
  queryClient: QueryClient,
  workspaceId: string,
  sidebar: Sidebar | undefined,
  signal: ChannelSignal,
): ChatList[] {
  const namesKey = channelNamesQueryKey(workspaceId);
  const reading = (queryKey: QueryKey) => queryClient.isFetching({ queryKey }) > 0;
  const read = queryClient.getQueryData<ChannelNamesRead>(namesKey);
  const known = Boolean(read?.names.some((channel) => channel.id === signal.conversationId));
  const stale: ChatList[] = [];
  if (read) {
    const next = channelNamesAfter(read.names, signal);
    // The positions stay: only a server read changes them.
    if (next) queryClient.setQueryData<ChannelNamesRead>(namesKey, { ...read, names: next });
    if (!next || reading(namesKey)) stale.push("channelNames");
  }
  if (
    !sidebar?.applyChannelSignal(signal, { known }) ||
    reading(sidebarChannelsQueryKey(workspaceId))
  )
    stale.push("channels");
  return stale;
}
