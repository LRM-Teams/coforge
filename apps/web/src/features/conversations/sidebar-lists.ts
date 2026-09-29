import { useMemo } from "react";
import { useHydrated } from "@tanstack/react-router";
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
  createSidebar,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type ChannelRow,
  type Sidebar,
} from "./sidebar-collections";
import { directListsOf, type DirectRow } from "./sidebar-rows";
import { sidebarRefreshQueue, type ChatList } from "./conversation-unread";

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

/** The sidebar once the page is hydrated; `undefined` during the server and hydrating renders. */
function useSidebar() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const hydrated = useHydrated();
  return useMemo(
    () => (hydrated ? sidebarFor(queryClient, workspaceId) : undefined),
    [hydrated, queryClient, workspaceId],
  );
}

/**
 * The sidebar's lists: channels in the server's order (a closed one only while pinned), the DM rows
 * by conversation id, and when the server last sent them (`readAt`, which a saved change does not move).
 * Server-rendered from the Query cache; after hydration read live from the collections.
 */
export function useSidebarLists() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Only a new read re-renders from these: after hydration the rows come from the collections.
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
    queryKey: ["sidebar-channels", workspaceId, Boolean(sidebar)],
    query: (q) => (sidebar ? q.from({ row: sidebar.channels }) : undefined),
  });
  const liveDirects = useLiveQuery({
    queryKey: ["sidebar-directs", workspaceId, Boolean(sidebar)],
    query: (q) => (sidebar ? q.from({ row: sidebar.directs }) : undefined),
  });
  // Until a live query is ready (the first tick after hydration) the cache holds the same rows.
  const channelRows: readonly ChannelRow[] =
    (liveChannels.isReady && liveChannels.data) || channelsCache.rows;
  const directRows: readonly DirectRow[] =
    (liveDirects.isReady && liveDirects.data) || directsCache.rows;
  const channels = useMemo(
    () =>
      [...channelRows]
        .sort((left, right) => left.position - right.position)
        .filter((channel) => !channel.hidden || channel.pinned),
    [channelRows],
  );
  const directs = useMemo(() => directListsOf(directRows), [directRows]);
  return {
    channels,
    directs,
    viewerId: directsCache.viewerId,
    readAt: `${channelsCache.fetchedAt}:${directsCache.fetchedAt}`,
  };
}

const listQueryKey: Record<ChatList, (workspaceId: string) => readonly unknown[]> = {
  channels: sidebarChannelsQueryKey,
  dms: sidebarDirectsQueryKey,
  channelNames: channelNamesQueryKey,
};

/**
 * Re-reads the named lists, and only them, after something outside the sidebar changed them: a
 * channel's creation, rename, description or archive (here, or `channel.created.v1` /
 * `channel.updated.v1`), a message that brings a closed or unlisted chat in, the Activity page
 * moving badges, or the viewer's own place in a chat changed on another page, tab or device (a
 * `ViewerEvent`). A burst is read once (`sidebarRefreshQueue`). The collections follow the
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

/** The sidebar's changes (pin, mark unread, close, drag); `undefined` before hydration, when
 * nothing in the sidebar is interactive yet. */
export function useSidebarActions() {
  return useSidebar()?.actions;
}
