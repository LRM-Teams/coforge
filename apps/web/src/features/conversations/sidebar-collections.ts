import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { createCollection, createOptimisticAction } from "@tanstack/react-db";
import type { PendingMutation, Transaction } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";

import { nextPinOrder, pinOrdersAfterArrange } from "#src/lib/pin-order";
import {
  listPublicChannels,
  setPublicConversationHidden,
  setPublicConversationPinned,
  setPublicConversationUnread,
} from "./channels.functions";
import {
  loadDirectConversationBadges,
  loadDirectConversationPreferences,
  setDirectConversationHidden,
  setDirectConversationPinned,
  setDirectConversationUnread,
} from "./conversations.functions";
import { arrangePinnedConversations } from "./conversation-pins.functions";
import { sidebarChannelsQueryKey, sidebarDirectsQueryKey } from "./conversation-query-keys";
import { pinOfRowKey, rowKeyOf, type PinRef } from "./pinned-conversations";
import { directRowsOf, type DirectRow } from "./sidebar-rows";

// The Chat sidebar's channel and DM lists as TanStack DB collections, and the changes made to them
// from the sidebar. How they fit with the Query cache and SSR: `features/conversations/AGENTS.md`.

type ChannelList = Awaited<ReturnType<typeof listPublicChannels>>;
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
      : setDirectConversationPinned({ data: { agentId: target.agentId, pinned } }),
  markUnread: (target) =>
    target.kind === "channel"
      ? setPublicConversationUnread({ data: { channelId: target.channelId, unread: true } })
      : setDirectConversationUnread({ data: { agentId: target.agentId, unread: true } }),
  close: (target) =>
    target.kind === "channel"
      ? setPublicConversationHidden({ data: { channelId: target.channelId, hidden: true } })
      : setDirectConversationHidden({ data: { agentId: target.agentId, hidden: true } }),
  arrange: (arrangement) =>
    arrangePinnedConversations({
      data: { pins: [...arrangement.pins], unpinned: [...arrangement.unpinned] },
    }),
};

/**
 * The channel list, with the server's order (#general first, then by name) kept as a field, and
 * when it was read: a direct write to the cache keeps `fetchedAt`, so only a server read changes it.
 */
function fetchChannels(api: SidebarApi) {
  return async () => ({
    fetchedAt: Date.now(),
    rows: (await api.listChannels()).map((channel, position) => ({ ...channel, position })),
  });
}

export type ChannelRow = Awaited<ReturnType<ReturnType<typeof fetchChannels>>>["rows"][number];

/**
 * The DM rows and the viewer's id. A re-read fails as a whole, so the list keeps the rows it has;
 * only a first load (`tolerant`) falls back per read, as the page always has: rows without pins or
 * badges, and no viewer id (so no personal signal channel keyed by an empty id).
 */
function fetchDirects(api: SidebarApi, { tolerant }: { tolerant: boolean }) {
  return async () => {
    const [preferences, badges] = await Promise.all([
      tolerant
        ? api.loadDirectPreferences().catch(() => ({ conversations: [], pinned: [], hidden: [] }))
        : api.loadDirectPreferences(),
      tolerant
        ? api.loadDirectBadges().catch(() => ({ viewerId: "", unread: {} }))
        : api.loadDirectBadges(),
    ]);
    return {
      fetchedAt: Date.now(),
      viewerId: badges.viewerId || undefined,
      rows: directRowsOf(preferences, badges.unread),
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
      getKey: (row: DirectRow) => row.agentId,
      select: (data) => data.rows,
      ...LIST_OPTIONS,
    }),
  );

  const rowOf = (target: PinRef): SidebarFields | undefined =>
    target.kind === "channel" ? channels.get(target.channelId) : directs.get(target.agentId);
  /** Changes one row on screen; a row that has left the list meanwhile is left alone. */
  const edit = (target: PinRef, change: (row: SidebarFields) => void) => {
    if (target.kind === "channel") {
      if (channels.has(target.channelId)) channels.update(target.channelId, change);
    } else if (directs.has(target.agentId)) directs.update(target.agentId, change);
  };
  /** Keeps a saved change as shown: its fields are written into the synced list, so it does not
   * depend on a later re-read. A row the list has dropped meanwhile has nothing to keep. */
  const confirm = (transaction: Transaction) => {
    const write = (mutation: PendingMutation) => {
      const key = String(mutation.key);
      if (mutation.collection.id === channels.id)
        channels.utils.writeUpdate({ ...mutation.changes, id: key });
      else directs.utils.writeUpdate({ ...mutation.changes, agentId: key });
    };
    for (const mutation of transaction.mutations) {
      try {
        write(mutation);
      } catch {
        // The row is no longer in the synced list: the next read shows the list as it is.
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

  // Marking unread anchors on the newest top-level message, so the badge shows at least one; the
  // re-read afterwards brings the true count.
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
          row.pinned ? [{ key: rowKeyOf({ kind: "channel", channelId: row.id }), row }] : [],
        ),
        ...directs.toArray.flatMap((row) =>
          row.pinned ? [{ key: rowKeyOf({ kind: "direct", agentId: row.agentId }), row }] : [],
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
      const save = arranging.then(() => api.arrange(arrangement));
      arranging = save.catch(() => undefined);
      await save;
      confirm(transaction);
    },
  });

  const persisted = (transaction: Transaction) => transaction.isPersisted.promise.then(() => {});
  const actions = {
    setPinned: (target: PinRef, pinned: boolean) => persisted(pin({ target, pinned })),
    // A row already showing unread has nothing to change on screen, but the mark is still saved.
    markUnread: (target: PinRef) =>
      (rowOf(target)?.unreadCount ?? 0) > 0
        ? api.markUnread(target).then(() => reread(target))
        : persisted(markUnreadAtOnce(target)),
    close: (target: PinRef) => persisted(close(target)),
    arrange: (arrangement: Arrangement) => persisted(arrange(arrangement)),
  };
  return { channels, directs, actions };
}

export type Sidebar = ReturnType<typeof createSidebar>;
