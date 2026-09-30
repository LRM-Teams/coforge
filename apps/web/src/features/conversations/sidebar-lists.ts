import { useMemo } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "./conversation-query-keys";
import {
  applyChannelSignalToLists,
  createSidebar,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type ChannelRow,
  type Sidebar,
} from "./sidebar-collections";
import { directListsOf, type DirectRow } from "./sidebar-rows";
import { savedMessagesQueryKey } from "./saved-messages-collection";
import { sidebarRefreshQueue, type ChatList } from "./conversation-unread";
import { compareChannelNames, type ChannelSignal } from "./channel-signals";
import type { StreamPosition } from "#src/features/realtime/subscription-gap";

// React access to the Chat sidebar's lists (`sidebar-collections.ts`).

const sidebarsByClient = new WeakMap<QueryClient, Map<string, Sidebar>>();

/** One sidebar (collections and actions) per `QueryClient` and Workspace, TanStack DB's
 * business-scope pattern: every consumer shares one sync, one optimistic state, one save queue. */
function sidebarFor(queryClient: QueryClient, workspaceId: string) {
  let byWorkspace = sidebarsByClient.get(queryClient);
  if (!byWorkspace) sidebarsByClient.set(queryClient, (byWorkspace = new Map()));
  let sidebar = byWorkspace.get(workspaceId);
  if (!sidebar) byWorkspace.set(workspaceId, (sidebar = createSidebar(queryClient, workspaceId)));
  return sidebar;
}

/** The sidebar: TanStack DB collections are client-only, and Chat is only rendered in the browser
 * (`createSidebar` fails on the server). */
function useSidebar() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return sidebarFor(queryClient, workspaceId);
}

/**
 * The sidebar's lists: channels in the server's order (a closed one only while pinned), the DM rows
 * by conversation id, and when the server last sent them (`readAt`, which a saved change does not move).
 * Read from the Query cache the chat loader filled until the live queries are ready, then live
 * from the collections.
 */
export function useSidebarLists() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Only a new read re-renders from these: once the live queries are ready the rows come from the
  // collections.
  const channelsCache = useSuspenseQuery({
    ...sidebarChannelsQuery(workspaceId),
    notifyOnChangeProps: ["dataUpdatedAt"],
  }).data;
  const directsCache = useSuspenseQuery({
    ...sidebarDirectsQuery(workspaceId),
    notifyOnChangeProps: ["dataUpdatedAt"],
  }).data;
  const sidebar = useSidebar();
  const liveChannels = useLiveQuery({
    queryKey: ["sidebar-channels", workspaceId],
    query: (q) => q.from({ row: sidebar.channels }),
  });
  const liveDirects = useLiveQuery({
    queryKey: ["sidebar-directs", workspaceId],
    query: (q) => q.from({ row: sidebar.directs }),
  });
  // Until a live query is ready (the first tick) the cache holds the same rows.
  const channelRows: readonly ChannelRow[] =
    (liveChannels.isReady && liveChannels.data) || channelsCache.rows;
  const directRows: readonly DirectRow[] =
    (liveDirects.isReady && liveDirects.data) || directsCache.rows;
  const channels = useMemo(
    () =>
      [...channelRows]
        .sort((left, right) => compareChannelNames(left.name, right.name))
        .filter((channel) => !channel.hidden || channel.pinned),
    [channelRows],
  );
  const directs = useMemo(() => directListsOf(directRows), [directRows]);
  return {
    channels,
    directs,
    viewerId: directsCache.viewerId,
    readAt: { channels: channelsCache.fetchedAt, dms: directsCache.fetchedAt },
  };
}

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
 * Where a list's last server read stands in a signal channel's stream (`chatStreamPositions`), for
 * `rereadMissedBySubscribe`; undefined for a list read without positions (all but the channel
 * list). A read under way settles first, so a subscribe that lands during the chat loader's read,
 * or during the refetch of a stored copy, is judged by that read instead of re-reading over it.
 */
export function useListReadPosition() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useMemo(
    () =>
      (list: ChatList, channel: string): Promise<StreamPosition | undefined> | undefined => {
        if (list !== "channels") return undefined;
        const { queryKey } = sidebarChannelsQuery(workspaceId);
        return readSettled(queryClient, queryKey).then(
          () => queryClient.getQueryData(queryKey)?.streamPositions?.[channel],
        );
      },
    [queryClient, workspaceId],
  );
}

const listQueryKey: Record<ChatList, (workspaceId: string) => readonly unknown[]> = {
  channels: sidebarChannelsQueryKey,
  dms: sidebarDirectsQueryKey,
  channelNames: channelNamesQueryKey,
  saved: savedMessagesQueryKey,
};

/**
 * Re-reads the named lists, and only them, after something outside the sidebar changed them: a
 * channel's creation, rename, description or archive here (another page's arrives as a channel
 * signal, `useApplyChannelSignal`), a message that brings a closed or unlisted chat in, the
 * Activity page moving badges, or the viewer's own place in a chat or their Saved list changed on
 * another page, tab or device (a `ViewerEvent`). A burst is read once (`sidebarRefreshQueue`). The collections follow the
 * refetched Query data.
 */
export function useRefreshSidebar() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useMemo(
    () =>
      sidebarRefreshQueue((lists) =>
        Promise.all(
          [...lists].map((list) =>
            queryClient.invalidateQueries({ queryKey: listQueryKey[list](workspaceId) }),
          ),
        ).then(() => undefined),
      ),
    [queryClient, workspaceId],
  );
}

/** Applies a channel created, changed or gone anywhere in the Workspace to the lists
 * (`applyChannelSignalToLists`), re-reading only what the event could not settle. */
export function useApplyChannelSignal() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const sidebar = useSidebar();
  const refresh = useRefreshSidebar();
  return useMemo(
    () => (signal: ChannelSignal) => {
      const stale = applyChannelSignalToLists(queryClient, workspaceId, sidebar, signal);
      if (stale.length > 0) void refresh(stale);
    },
    [queryClient, workspaceId, sidebar, refresh],
  );
}

/** Re-reads the channel list alone: a channel changed outside the sidebar (a rename, description or
 * archive here, or the viewer's own leave or mute from the settings panel). */
export function useRefreshSidebarChannels() {
  const refresh = useRefreshSidebar();
  return useMemo(() => () => refresh(["channels"]), [refresh]);
}

/** Re-reads both lists after a change made on another page moved their unread badges (the Activity
 * page reading or marking Done). */
export function useRefreshSidebarLists() {
  const refresh = useRefreshSidebar();
  return useMemo(() => () => refresh(["channels", "dms"]), [refresh]);
}

/** The sidebar's changes (pin, mark unread, close, drag). */
export function useSidebarActions() {
  return useSidebar().actions;
}
