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
import { CreateChannelDialog } from "./create-channel-dialog";
import { rememberConversation } from "./last-conversation";
import { useChannelUnread } from "./conversation-unread";
import { useRefreshSidebarChannels, useSidebarLists } from "./sidebar-lists";

const messagesRoute = getRouteApi("/_app/messages");
const ConversationListContext = createContext<{
  showList: () => void;
  /** Hides the list and reveals the detail pane. Called when a directory row is chosen, so a tap
   * opens the conversation even when the URL does not change (the row that is already current). */
  closeList: () => void;
  detailVisible: boolean;
} | null>(null);

type UnreadControls = {
  /** Per-channel unread counts, keyed by conversation id. */
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
  const { projects, channelNames } = messagesRoute.useLoaderData();
  const { channels, directs, viewerId, readAt } = useSidebarLists();
  const agents = useLiveAgents();
  const workspaceId = useCurrentWorkspaceId();
  const desktop = useBreakpoint("lg");
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const create = useServerFn(createPublicChannel);
  const channel = useParams({ from: "/_app/messages/channels/$channelId", shouldThrow: false });
  const agent = useParams({ from: "/_app/messages/$agentId", shouldThrow: false });
  const showList = browsing || pathname === "/messages" || pathname === "/messages/";
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

  // The conversation this is becomes the one Chat reopens in this Workspace. Only a conversation
  // the user moved to counts: a Workspace switch keeps the URL, and recording it then would file the
  // old Workspace's conversation under the new one.
  const rememberedPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!workspaceId || pathname === rememberedPath.current) return;
    rememberedPath.current = pathname;
    rememberConversation(workspaceId, pathname);
  }, [workspaceId, pathname]);

  const visibleChannels = useMemo(() => channels.filter((listed) => !listed.archived), [channels]);
  const hiddenAgentIds = useMemo(() => new Set(directs.hiddenAgentIds), [directs]);
  const closedChatRefresh = useRef<"idle" | "running" | "queued">("idle");
  const refreshChannels = useRefreshSidebarChannels();
  const unread = useChannelUnread({
    workspaceId,
    userId: viewerId,
    channels: visibleChannels,
    openConversationId: channel?.channelId,
    // The open DM's own events must not bump its badge: they are being read right now.
    openAgentId: agent?.agentId,
    hiddenAgentIds,
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
    // A channel was renamed, described, archived or unarchived: only the channel list is stale.
    onChannelUpdated: () => void refreshChannels(),
  });
  // Every server read of the lists carries the persisted counts; local arithmetic restarts from
  // them (sequence boundaries survive, so no event double-counts). Direct messages are already
  // keyed by Agent id, the same key their realtime signal carries. A re-seed follows each server
  // read (`readAt`) and each change of a count shown (a mark-unread), not a pin, a drag, or a
  // closed row with nothing unread.
  const { counts } = unread;
  const refresh = unread.replace;
  const seed = useMemo(() => {
    const entries = [
      ...visibleChannels.map((listed) => ({ id: listed.id, unreadCount: listed.unreadCount })),
      ...Object.entries(directs.unread).map(([agentId, unreadCount]) => ({
        id: agentId,
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
                  directRows={directs.byAgent}
                  selectedChannelId={channel?.channelId}
                  selectedAgentId={agent?.agentId}
                  selectedSaved={pathname === "/messages/saved"}
                  onCreateChannel={() => setCreating(true)}
                />
              </div>
              <LiveAgentActivityBar agents={agents} />
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
                await router.invalidate({ sync: true });
                await router.navigate({
                  to: "/messages/channels/$channelId",
                  params: { channelId: result.id },
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
