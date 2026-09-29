import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getRouteApi, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { PageHeader } from "#src/components/layout/page-header";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
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
import { channelNamesQuery } from "./conversation-queries";
import { projectsQuery } from "#src/features/projects/project-tree-queries";
import { rememberConversation } from "./last-conversation";
import { useChannelUnread } from "./conversation-unread";
import { useRefreshSidebar, useSidebarLists } from "./sidebar-lists";
import { listedDirectIds } from "./sidebar-rows";
import { workspacePath } from "#src/features/workspaces/workspace-url";

const messagesRoute = getRouteApi("/w/$workspaceSlug/_chat");
const ConversationListContext = createContext<{
  showList: () => void;
  /** Hides the list and reveals the detail pane. Called when a directory row is chosen, so a tap
   * opens the conversation even when the URL does not change (the row that is already current). */
  closeList: () => void;
  detailVisible: boolean;
} | null>(null);

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
  const { workspaceId: chatWorkspaceId } = messagesRoute.useLoaderData();
  // Every channel by id, from the Query cache the chat loader filled; kept live by
  // `channel.created.v1` / `channel.updated.v1` (`workspaceSignalLists`).
  const channelNames = useSuspenseQuery(channelNamesQuery(chatWorkspaceId)).data;
  const { channels, directs, viewerId, readAt } = useSidebarLists();
  const agents = useLiveAgents();
  const workspaceId = useCurrentWorkspaceId();
  const workspaceSlug = useWorkspaceSlug();
  const desktop = useBreakpoint("lg");
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  // The projects a new channel can join: read when the dialog opens, not on every navigation.
  const projects = useQuery({ ...projectsQuery(chatWorkspaceId), enabled: creating }).data;
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
  const closedChatRefresh = useRef<"idle" | "running" | "queued">("idle");
  const refreshSidebar = useRefreshSidebar();
  const unread = useChannelUnread({
    workspaceId,
    userId: viewerId,
    channels: visibleChannels,
    // The open channel's or DM's own events must not bump its badge: they are being read now.
    openConversationId: channel?.channelId ?? openDm?.dmId,
    listedConversationIds,
    onClosedConversationActivity: () => {
      // One refresh at a time: a burst of messages needs a single re-read of the list. A message
      // that lands mid-refresh may have missed that read, so it queues exactly one more.
      if (closedChatRefresh.current !== "idle") {
        closedChatRefresh.current = "queued";
        return;
      }
      const refresh = () => {
        closedChatRefresh.current = "running";
        void router.invalidate().finally(() => {
          if (closedChatRefresh.current === "queued") refresh();
          else closedChatRefresh.current = "idle";
        });
      };
      refresh();
    },
    // A channel changed, or the viewer joined, left, closed, muted or pinned a chat elsewhere:
    // only the lists named are stale.
    onSidebarListsChanged: (lists) => void refreshSidebar(lists),
  });
  // Every server read of the lists carries the persisted counts; local arithmetic restarts from
  // them (sequence boundaries survive, so no event double-counts). Channels and DMs alike are
  // keyed by conversation id, the id their realtime signal carries. A re-seed follows each server
  // read (`readAt`) and each change of a count shown (a mark-unread), not a pin, a drag, or a
  // closed row with nothing unread.
  const { counts } = unread;
  const refresh = unread.replace;
  const seed = useMemo(() => {
    const entries = [
      ...visibleChannels.map((listed) => ({ id: listed.id, unreadCount: listed.unreadCount })),
      ...Object.entries(directs.unread).map(([conversationId, unreadCount]) => ({
        id: conversationId,
        unreadCount,
      })),
    ];
    const counts = entries
      .flatMap((entry) => (entry.unreadCount > 0 ? [`${entry.id}:${entry.unreadCount}`] : []))
      .join(",");
    return { entries, key: `${readAt}|${counts}` };
  }, [visibleChannels, directs, readAt]);
  useEffect(() => {
    refresh(seed.entries);
  }, [refresh, seed.key]);
  const controls = useMemo<UnreadControls>(
    () => ({ counts, clear: unread.clear }),
    [counts, unread.clear],
  );
  return (
    <ConversationListContext
      value={{
        showList: () => setBrowsing(true),
        closeList: () => setBrowsing(false),
        detailVisible: desktop || !showList,
      }}
    >
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

export function ConversationListButton() {
  const navigation = useContext(ConversationListContext);
  if (!navigation) return null;
  return (
    <ButtonUtility
      icon={ArrowLeft}
      size="sm"
      color="tertiary"
      aria-label={m.conversation_back_to_list()}
      onClick={navigation.showList}
      className="-ml-2 shrink-0 lg:hidden"
    />
  );
}
