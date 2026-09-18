import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getRouteApi, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { PageHeader } from "@/components/layout/page-header";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { ConversationDirectory } from "./conversation-directory";
import { m } from "@/paraglide/messages";
import { cx } from "@/utils/cx";
import { createPublicChannel } from "./channels.functions";
import { useCurrentWorkspaceId, useLiveAgents } from "@/features/agents/workspace-agents-realtime";
import { CreateChannelDialog } from "./create-channel-dialog";
import { useChannelUnread } from "./conversation-unread";

const messagesRoute = getRouteApi("/_app/messages");
const appRoute = getRouteApi("/_app");
const ConversationListContext = createContext<{
  showList: () => void;
  detailVisible: boolean;
} | null>(null);

/**
 * The open conversation's pane reports whether the user is currently reading the latest
 * message. Only consumed by the `newest-unread` open mode, which keeps unseen messages
 * unread until the latest is actually viewed. The pane below the provider reports through
 * `reportReadingLatest`; the route reads through `useReadingLatest`.
 */
const ReadingLatestContext = createContext<{
  readingLatest: boolean;
  reportReadingLatest: (reading: boolean) => void;
}>({ readingLatest: true, reportReadingLatest: () => {} });

export function useReadingLatest(): boolean {
  return useContext(ReadingLatestContext).readingLatest;
}

/** The open pane's reporter; a no-op outside `ConversationNavigation`. */
export function useReadingLatestReporter() {
  return useContext(ReadingLatestContext);
}

type UnreadControls = {
  /** Per-channel unread counts, keyed by conversation id. */
  counts: Readonly<Record<string, number>>;
  /** Clears one conversation's badge and records the sequence it was read through. */
  clear: (conversationId: string, readThroughSequence?: number) => void;
};

const UnreadContext = createContext<UnreadControls>({ counts: {}, clear: () => {} });
const OpenModeContext = createContext<string>("newest-read");

export function useConversationDetailVisible() {
  return useContext(ConversationListContext)?.detailVisible ?? true;
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

/** The user's "When I view a channel" open behavior, from their saved preferences. */
export function useConversationOpenMode(): string {
  return useContext(OpenModeContext);
}

/**
 * Whether the read cursor must wait for the user to actually reach the bottom
 * (`newest-unread`): opening the conversation clears the sidebar badge but the
 * server-side cursor only advances once the pane reports the latest was read.
 */
export function useConversationReadRequiresScroll(): boolean {
  return useContext(OpenModeContext) === "newest-unread";
}

/** Keep both panels mounted so returning to the list preserves scroll and drafts. */
export function ConversationNavigation({ children }: { children: ReactNode }) {
  const { channels, projects, directUnread } = messagesRoute.useLoaderData();
  const { conversationOpenMode } = appRoute.useLoaderData();
  const agents = useLiveAgents();
  const workspaceId = useCurrentWorkspaceId();
  const desktop = useBreakpoint("lg");
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [readingLatest, setReadingLatest] = useState(true);
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

  const visibleChannels = useMemo(() => channels.filter((listed) => !listed.archived), [channels]);
  const unread = useChannelUnread({
    workspaceId,
    channels: visibleChannels,
    directUnread,
    openConversationId: channel?.channelId,
  });
  // Every loader refresh carries the server's own persisted counts; local arithmetic
  // restarts from them (sequence boundaries survive, so no event double-counts).
  const { counts } = unread;
  const refresh = unread.replace;
  useEffect(() => {
    refresh([
      ...visibleChannels,
      ...Object.entries(directUnread.conversationAgentIds).map(([conversationId, agentId]) => ({
        id: agentId,
        unreadCount: directUnread.counts[conversationId],
      })),
    ]);
  }, [refresh, visibleChannels, directUnread]);
  const controls = useMemo<UnreadControls>(
    () => ({ counts, clear: unread.clear }),
    [counts, unread.clear],
  );

  return (
    <ConversationListContext
      value={{ showList: () => setBrowsing(true), detailVisible: desktop || !showList }}
    >
      <OpenModeContext value={conversationOpenMode}>
        <ReadingLatestContext value={{ readingLatest, reportReadingLatest: setReadingLatest }}>
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
                    selectedChannelId={channel?.channelId}
                    selectedAgentId={agent?.agentId}
                    onCreateChannel={() => setCreating(true)}
                  />
                </div>
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
        </ReadingLatestContext>
      </OpenModeContext>
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
