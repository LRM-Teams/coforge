import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { PageHeader } from "#src/components/layout/page-header";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { ConversationListContext } from "./conversation-list-button";
import { ConversationDirectory } from "./conversation-directory";
import { LiveAgentActivityBar } from "./live-agent-activity-bar";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { createPublicChannel } from "./channels.functions";
import { ConversationHostProvider } from "./conversation-host";
import {
  useCurrentWorkspaceId,
  useLiveAgents,
} from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { CreateChannelDialog } from "./create-channel-dialog";
import {
  channelNamesQuery,
  directConversationQuery,
  publicChannelQuery,
} from "./conversation-queries";
import {
  adoptReadThrough,
  noteReadThrough,
} from "#src/features/cache-persistence/browser-query-cache";
import { projectsQuery } from "#src/features/projects/project-tree-queries";
import { rememberConversation } from "./last-conversation";
import {
  unknownAgentOf,
  unreadIdsToKeep,
  useChannelUnread,
  type SeededList,
} from "./conversation-unread";
import {
  useApplyChannelSignal,
  useListReadPosition,
  useRefreshSidebar,
  useSidebarLists,
} from "./sidebar-lists";
import { listedDirectIds } from "./sidebar-rows";
import { workspacePath } from "#src/features/workspaces/workspace-url";

type UnreadControls = {
  /** Per-conversation unread counts (channels and DMs), keyed by conversation id. */
  counts: Readonly<Record<string, number>>;
  /** Clears one conversation's badge and records the sequence it was read through. */
  clear: (conversationId: string, readThroughSequence?: number) => void;
};

const UnreadContext = createContext<UnreadControls>({ counts: {}, clear: () => {} });

export function useConversationDetailVisible() {
  return useContext(ConversationListContext)?.detailVisible ?? true;
}

/** Hides the mobile conversation list so the chosen conversation's pane shows. */
export function useCloseConversationList(): () => void {
  const navigation = useContext(ConversationListContext);
  return navigation?.closeList ?? (() => {});
}

/** The sidebar's live unread counts, seeded from the loader and updated by realtime. */
export function useChannelUnreadCounts(): Readonly<Record<string, number>> {
  return useContext(UnreadContext).counts;
}

/** Marks a conversation seen: clears its badge immediately and records the read boundary. */
export function useMarkConversationSeen(): (
  conversationId: string,
  readThroughSequence?: number,
) => void {
  return useContext(UnreadContext).clear;
}

/** Keep both panels mounted so returning to the list preserves scroll and drafts. */
export function ConversationNavigation({ children }: { children: ReactNode }) {
  const { channels, directs, viewerId, readAt } = useSidebarLists();
  const agents = useLiveAgents();
  const workspaceId = useCurrentWorkspaceId();
  // Every channel by id, from the Query cache the chat loader filled; kept live by
  // `channel.created.v1` / `channel.updated.v1` (`useApplyChannelSignal`).
  const channelNames = useSuspenseQuery(channelNamesQuery(workspaceId ?? "")).data;
  const workspaceSlug = useWorkspaceSlug();
  const desktop = useBreakpoint("lg");
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  // The projects a new channel can join: read when the dialog opens, not on every navigation.
  const projects = useQuery({ ...projectsQuery(workspaceId ?? ""), enabled: creating }).data;
  const create = useServerFn(createPublicChannel);
  const channel = useParams({
    from: "/w/$workspaceSlug/_chat/channel/$channelId",
    shouldThrow: false,
  });
  const openDm = useParams({ from: "/w/$workspaceSlug/_chat/dm/$dmId", shouldThrow: false });
  const showList =
    browsing ||
    pathname === workspacePath(workspaceSlug) ||
    pathname === workspacePath(workspaceSlug, "/");
  useEffect(() => {
    // Leaving the conversation list is a path change (tapping a row). Loader
    // re-resolves (`invalidate`, hash replace) must not bounce the user back
    // into the hidden conversation on mobile.
    let pathname = router.state.location.pathname;
    return router.subscribe("onResolved", () => {
      const next = router.state.location.pathname;
      if (next === pathname) return;
      pathname = next;
      setBrowsing(false);
    });
  }, [router]);

  // The conversation this is becomes the one Chat reopens in this Workspace. While a move to another
  // Workspace is pending the URL already names it but the Workspace in hand is still the old one:
  // only a path inside the Workspace in hand is filed under its id.
  const rememberedPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!workspaceId || pathname === rememberedPath.current) return;
    if (!pathname.startsWith(workspacePath(workspaceSlug, "/"))) return;
    rememberedPath.current = pathname;
    rememberConversation(workspaceId, pathname);
  }, [workspaceId, workspaceSlug, pathname]);

  const visibleChannels = useMemo(() => channels.filter((listed) => !listed.archived), [channels]);
  const listedConversationIds = useMemo(
    () => new Set([...visibleChannels.map((row) => row.id), ...listedDirectIds(directs, agents)]),
    [visibleChannels, directs, agents],
  );
  const refreshSidebar = useRefreshSidebar();
  const readPosition = useListReadPosition();
  const queryClient = useQueryClient();
  const applyChannelSignal = useApplyChannelSignal();
  const knownAgentIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  // The Workspace layout's Agent roster only re-reads through the router: one re-read at a time.
  const rosterRefresh = useRef<Promise<void> | undefined>(undefined);
  const unread = useChannelUnread({
    workspaceId,
    userId: viewerId,
    channels: visibleChannels,
    // The open channel's or DM's own events must not bump its badge: they are being read now.
    openConversationId: channel?.channelId ?? openDm?.dmId,
    listedConversationIds,
    // A message brought a closed chat back, or a DM the list has not read yet: re-read that one
    // list, not the page (a burst is read once).
    onClosedConversationActivity: (lists, event) => {
      void refreshSidebar(lists);
      // A new Agent writing first: its DM row needs the Agent in the roster, which only the
      // layout's loader reads.
      if (unknownAgentOf(event, knownAgentIds) && !rosterRefresh.current)
        rosterRefresh.current = router.invalidate().finally(() => {
          rosterRefresh.current = undefined;
        });
    },
    // A channel was created, changed or is gone: applied from the event, not re-read.
    onChannelSignal: applyChannelSignal,
    // The viewer joined, left, closed, muted or pinned a chat elsewhere: only the lists named
    // are stale.
    onSidebarListsChanged: (lists) => void refreshSidebar(lists),
    readPosition,
    onReadCursorMoved: ({ kind, conversationId, throughSequence, adoptNow }) => {
      const { queryKey } = (kind === "channel" ? publicChannelQuery : directConversationQuery)(
        conversationId,
      ).query;
      noteReadThrough(queryClient, queryKey, throughSequence);
      if (adoptNow) adoptReadThrough(queryClient, queryKey);
    },
  });
  // Every server read of the lists carries the persisted counts; local arithmetic restarts from
  // them (sequence boundaries survive, so no event double-counts). Channels and DMs alike are
  // keyed by conversation id, the id their realtime signal carries. A re-seed follows each server
  // read (`readAt`) and each change of a count shown (a mark-unread), not a pin, a drag, or a
  // closed row with nothing unread.
  const { counts } = unread;
  const refresh = unread.replace;
  const seed = useMemo(() => {
    const lists: SeededList[] = [
      {
        readAt: readAt.channels,
        rows: visibleChannels.map((listed) => ({ id: listed.id, unreadCount: listed.unreadCount })),
      },
      {
        readAt: readAt.dms,
        rows: Object.entries(directs.unread).map(([conversationId, unreadCount]) => ({
          id: conversationId,
          unreadCount,
        })),
      },
    ];
    const entries = lists.flatMap((list) => list.rows);
    const counts = entries
      .flatMap((entry) =>
        entry.unreadCount && entry.unreadCount > 0 ? [`${entry.id}:${entry.unreadCount}`] : [],
      )
      .join(",");
    return { lists, entries, key: `${readAt.channels}:${readAt.dms}|${counts}` };
  }, [visibleChannels, directs, readAt.channels, readAt.dms]);
  // A list not read again since the last seed keeps its live counts (`unreadIdsToKeep`).
  const lastSeed = useRef<readonly SeededList[] | undefined>(undefined);
  useEffect(() => {
    refresh(seed.entries, unreadIdsToKeep(seed.lists, lastSeed.current));
    lastSeed.current = seed.lists;
  }, [refresh, seed.key]);
  const controls = useMemo<UnreadControls>(
    () => ({ counts, clear: unread.clear }),
    [counts, unread.clear],
  );
  // This renders on every live Agent or sidebar change; a new value each time would re-render
  // every reader, the open conversation's panes included.
  const detailVisible = desktop || !showList;
  const listControls = useMemo(
    () => ({
      showList: () => setBrowsing(true),
      closeList: () => setBrowsing(false),
      detailVisible,
    }),
    [detailVisible],
  );
  return (
    <ConversationListContext value={listControls}>
      <ConversationHostProvider channels={channelNames}>
        <UnreadContext value={controls}>
          <main className="flex h-svh min-w-0 flex-col bg-primary lg:flex-row">
            <section
              className={cx(
                "min-h-0 flex-1 flex-col lg:flex lg:w-72 lg:flex-none lg:border-r lg:border-secondary",
                showList ? "flex" : "hidden",
              )}
            >
              <PageHeader heading={m.navigation_chat()} />
              <div className="min-h-0 flex-1 overflow-y-auto py-4">
                <ConversationDirectory
                  channels={visibleChannels}
                  agents={agents}
                  directRows={directs.rows}
                  viewerId={viewerId}
                  selectedChannelId={channel?.channelId}
                  selectedDmId={openDm?.dmId}
                  selectedSaved={pathname === workspacePath(workspaceSlug, "/saved")}
                  onCreateChannel={() => setCreating(true)}
                />
              </div>
              <LiveAgentActivityBar agents={agents} agentDms={directs.agentDms} />
            </section>
            <div
              className={cx(
                "min-h-0 min-w-0 flex-1 flex-col lg:flex",
                showList ? "hidden" : "flex",
              )}
            >
              {children}
            </div>
          </main>
          {creating && (
            <CreateChannelDialog
              open={creating}
              onOpenChange={setCreating}
              projects={projects}
              onCreate={async (name, projectId) => {
                const result = await create({ data: { name, projectId } });
                // Only the channel list and names changed: re-read those before opening it.
                await refreshSidebar(["channels", "channelNames"]);
                await router.navigate({
                  to: "/w/$workspaceSlug/channel/$channelId",
                  params: { workspaceSlug, channelId: result.id },
                });
              }}
            />
          )}
        </UnreadContext>
      </ConversationHostProvider>
    </ConversationListContext>
  );
}
