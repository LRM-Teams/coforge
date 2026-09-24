import { useMemo } from "react";
import { useHydrated } from "@tanstack/react-router";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { createCollection, createOptimisticAction, useLiveQuery } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
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
import {
  directRowsOf,
  directViewOf,
  nextPinOrder,
  pinOrdersAfterArrange,
  type DirectRow,
} from "./sidebar-rows";

/**
 * The Chat sidebar's channel and DM lists, and the changes a member makes to them from the
 * sidebar (pin, mark unread, close, drag).
 *
 * Both lists live in the TanStack Query cache under per-Workspace keys. The `/messages` loader
 * fetches them there on the server, so the sidebar is server-rendered and the cache arrives
 * hydrated. After hydration the same keys back two TanStack DB collections
 * ([Query collection](https://tanstack.com/db/latest/docs/collections/query-collection)), which
 * start from the hydrated data without a request. Every change is an optimistic action
 * ([mutations](https://tanstack.com/db/latest/docs/guides/mutations)): the row changes on screen
 * at once, the server call follows, the list is re-read, and a failure puts the rows back.
 * Collections are client-only, so they are created per `QueryClient` and Workspace after
 * hydration, never at module scope.
 */

const sidebarKeys = {
  channels: (workspaceId: string) => ["conversations", "sidebar", workspaceId, "channels"] as const,
  directs: (workspaceId: string) => ["conversations", "sidebar", workspaceId, "directs"] as const,
};

/** The channel list with the server's order (#general first, then by name) kept as a field, so
 * the live query can sort by it. */
async function fetchChannelRows() {
  return (await listPublicChannels()).map((channel, position) => ({ ...channel, position }));
}

export type ChannelRow = Awaited<ReturnType<typeof fetchChannelRows>>[number];

/** The DM preferences and badges both tolerate a failed read, as the page always has: the rows
 * then render as plain Agent rows (no menu, no pin order, no badge). */
const NO_DIRECT_PREFERENCES = { conversations: [], pinned: [], hidden: [] };
const NO_DIRECT_BADGES = { viewerId: "", unread: {} };

async function fetchDirects(): Promise<{ viewerId?: string; rows: DirectRow[] }> {
  const [preferences, badges] = await Promise.all([
    loadDirectConversationPreferences().catch(() => NO_DIRECT_PREFERENCES),
    loadDirectConversationBadges().catch(() => NO_DIRECT_BADGES),
  ]);
  return {
    // Absent when the badge read failed: the sidebar then holds no personal signal channel
    // rather than subscribing to one keyed by an empty id.
    viewerId: badges.viewerId || undefined,
    rows: directRowsOf(preferences, badges.unread),
  };
}

export const sidebarChannelsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: sidebarKeys.channels(workspaceId), queryFn: fetchChannelRows });

export const sidebarDirectsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: sidebarKeys.directs(workspaceId), queryFn: fetchDirects });

function createSidebarCollections(queryClient: QueryClient, workspaceId: string) {
  return {
    channels: createCollection(
      queryCollectionOptions({
        id: `sidebar-channels:${workspaceId}`,
        queryKey: sidebarKeys.channels(workspaceId),
        queryFn: fetchChannelRows,
        queryClient,
        getKey: (row) => row.id,
      }),
    ),
    directs: createCollection(
      queryCollectionOptions({
        id: `sidebar-directs:${workspaceId}`,
        queryKey: sidebarKeys.directs(workspaceId),
        queryFn: fetchDirects,
        queryClient,
        getKey: (row: DirectRow) => row.agentId,
        select: (data) => data.rows,
      }),
    ),
  };
}

type SidebarCollections = ReturnType<typeof createSidebarCollections>;

const collectionsByClient = new WeakMap<QueryClient, Map<string, SidebarCollections>>();

/** One pair of collections per `QueryClient` and Workspace (TanStack DB's business-scope
 * pattern): every sidebar consumer shares them, so there is one sync and one optimistic state. */
function sidebarCollections(queryClient: QueryClient, workspaceId: string) {
  let byWorkspace = collectionsByClient.get(queryClient);
  if (!byWorkspace) {
    byWorkspace = new Map();
    collectionsByClient.set(queryClient, byWorkspace);
  }
  let collections = byWorkspace.get(workspaceId);
  if (!collections) {
    collections = createSidebarCollections(queryClient, workspaceId);
    byWorkspace.set(workspaceId, collections);
  }
  return collections;
}

/** The collections once the page is hydrated; `undefined` during the server render and the
 * hydrating render, which read the Query cache instead. */
function useSidebarCollections() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const hydrated = useHydrated();
  return useMemo(
    () => (hydrated ? sidebarCollections(queryClient, workspaceId) : undefined),
    [hydrated, queryClient, workspaceId],
  );
}

/**
 * The sidebar's lists: channels in the server's order (a closed one only while it is pinned), the
 * DM preferences, the DM unread counts, and the viewer's id. Server-rendered from the Query cache;
 * after hydration read live from the collections, which show optimistic changes at once.
 */
export function useSidebarLists() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channelsCache = useSuspenseQuery(sidebarChannelsQuery(workspaceId)).data;
  const directsCache = useSuspenseQuery(sidebarDirectsQuery(workspaceId)).data;
  const collections = useSidebarCollections();
  const liveChannels = useLiveQuery({
    query: (q) =>
      collections
        ? q.from({ row: collections.channels }).orderBy(({ row }) => row.position)
        : undefined,
  });
  const liveDirects = useLiveQuery({
    query: (q) => (collections ? q.from({ row: collections.directs }) : undefined),
  });
  // Until a live query is ready (the first tick after hydration) the cache is the same data.
  const channelRows: readonly ChannelRow[] =
    (liveChannels.isReady && liveChannels.data) || channelsCache;
  const directRows: readonly DirectRow[] =
    (liveDirects.isReady && liveDirects.data) || directsCache.rows;
  const channels = useMemo(
    () => channelRows.filter((channel) => !channel.hidden || channel.pinned),
    [channelRows],
  );
  const directs = useMemo(() => directViewOf(directRows), [directRows]);
  return {
    channels,
    directPreferences: directs.preferences,
    directUnread: directs.unread,
    viewerId: directsCache.viewerId,
  };
}

/**
 * Re-reads the channel list, and only it, after something outside the sidebar changed a channel:
 * a rename, description or archive (here or signalled from another page), or the viewer's own
 * leave or mute. The collection follows the refetched Query data.
 */
export function useRefreshSidebarChannels() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useMemo(
    () => () =>
      queryClient.invalidateQueries({ queryKey: sidebarChannelsQuery(workspaceId).queryKey }),
    [queryClient, workspaceId],
  );
}

/**
 * Re-reads both sidebar lists after a change made on another page moved their unread badges (the
 * Activity page reading or marking Done).
 */
export function useRefreshSidebarLists() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useMemo(
    () => () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sidebarChannelsQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: sidebarDirectsQuery(workspaceId).queryKey }),
      ]).then(() => undefined),
    [queryClient, workspaceId],
  );
}

/** A sidebar row a change is about: a channel by id, a DM by its Agent. */
export type SidebarTarget = { kind: "channel"; id: string } | { kind: "direct"; agentId: string };

/**
 * The changes a member makes from the sidebar, each shown at once and then saved. Each returns the
 * TanStack DB transaction; `isPersisted.promise` rejects when the save failed (the rows are
 * already back by then). `undefined` before hydration, when nothing in the sidebar is
 * interactive yet.
 */
export function useSidebarActions() {
  const collections = useSidebarCollections();
  return useMemo(
    () => (collections ? createSidebarActions(collections) : undefined),
    [collections],
  );
}

function createSidebarActions({ channels, directs }: SidebarCollections) {
  const allPins = () => [
    ...channels.toArray.map((row) => ({ pinned: row.pinned, order: row.pinSortOrder })),
    ...directs.toArray.map((row) => ({ pinned: row.pinned, order: row.sortOrder })),
  ];
  // Drags are saved one after another, in the order they were made: two saves in flight could
  // otherwise reach the server in either order and the older layout win.
  let arranging: Promise<unknown> = Promise.resolve();

  const setPinned = createOptimisticAction<{ target: SidebarTarget; pinned: boolean }>({
    onMutate: ({ target, pinned }) => {
      const order = nextPinOrder(allPins());
      if (target.kind === "channel")
        channels.update(target.id, (row) => {
          if (row.pinned === pinned) return;
          row.pinned = pinned;
          row.pinSortOrder = pinned ? order : null;
        });
      else
        directs.update(target.agentId, (row) => {
          if (row.pinned === pinned) return;
          row.pinned = pinned;
          row.sortOrder = pinned ? order : null;
        });
    },
    mutationFn: async ({ target, pinned }) => {
      if (target.kind === "channel") {
        await setPublicConversationPinned({ data: { channelId: target.id, pinned } });
        await channels.utils.refetch();
      } else {
        await setDirectConversationPinned({ data: { agentId: target.agentId, pinned } });
        await directs.utils.refetch();
      }
    },
  });

  // Marking unread anchors on the newest top-level message, so the badge shows at least one.
  const markUnread = createOptimisticAction<SidebarTarget>({
    onMutate: (target) => {
      if (target.kind === "channel")
        channels.update(target.id, (row) => {
          row.unreadCount = Math.max(1, row.unreadCount);
        });
      else
        directs.update(target.agentId, (row) => {
          row.unread = Math.max(1, row.unread);
        });
    },
    mutationFn: async (target) => {
      if (target.kind === "channel") {
        await setPublicConversationUnread({ data: { channelId: target.id, unread: true } });
        await channels.utils.refetch();
      } else {
        await setDirectConversationUnread({ data: { agentId: target.agentId, unread: true } });
        await directs.utils.refetch();
      }
    },
  });

  const close = createOptimisticAction<SidebarTarget>({
    onMutate: (target) => {
      if (target.kind === "channel")
        channels.update(target.id, (row) => {
          row.hidden = true;
        });
      else
        directs.update(target.agentId, (row) => {
          row.hidden = true;
        });
    },
    mutationFn: async (target) => {
      if (target.kind === "channel") {
        await setPublicConversationHidden({ data: { channelId: target.id, hidden: true } });
        await channels.utils.refetch();
      } else {
        await setDirectConversationHidden({ data: { agentId: target.agentId, hidden: true } });
        await directs.utils.refetch();
      }
    },
  });

  type Arrangement = Parameters<typeof arrangePinnedConversations>[0]["data"];
  const keyOf = (ref: Arrangement["pins"][number]) =>
    ref.kind === "channel" ? `channel:${ref.channelId}` : `direct:${ref.agentId}`;
  const arrange = createOptimisticAction<Arrangement>({
    onMutate: (arrangement) => {
      const current = [
        ...channels.toArray.flatMap((row) =>
          row.pinned ? [{ key: `channel:${row.id}`, order: row.pinSortOrder ?? 0 }] : [],
        ),
        ...directs.toArray.flatMap((row) =>
          row.pinned ? [{ key: `direct:${row.agentId}`, order: row.sortOrder ?? 0 }] : [],
        ),
      ];
      const orders = pinOrdersAfterArrange(current, {
        pins: arrangement.pins.map(keyOf),
        unpinned: arrangement.unpinned.map(keyOf),
      });
      for (const row of channels.toArray) {
        const order = orders.get(`channel:${row.id}`);
        if (order === undefined || order === row.pinSortOrder) continue;
        channels.update(row.id, (draft) => {
          draft.pinned = order !== null;
          draft.pinSortOrder = order;
        });
      }
      for (const row of directs.toArray) {
        const order = orders.get(`direct:${row.agentId}`);
        if (order === undefined || order === row.sortOrder) continue;
        directs.update(row.agentId, (draft) => {
          draft.pinned = order !== null;
          draft.sortOrder = order;
        });
      }
    },
    mutationFn: async (arrangement) => {
      const save = arranging.then(() => arrangePinnedConversations({ data: arrangement }));
      arranging = save.catch(() => undefined);
      await save;
      await Promise.all([channels.utils.refetch(), directs.utils.refetch()]);
    },
  });

  return { setPinned, markUnread, close, arrange };
}
