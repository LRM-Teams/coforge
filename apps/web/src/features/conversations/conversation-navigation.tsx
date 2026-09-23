import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getRouteApi, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { PageHeader } from "@/components/layout/page-header";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { ConversationDirectory } from "./conversation-directory";
import { LiveAgentActivityBar } from "./live-agent-activity-bar";
import { m } from "@/paraglide/messages";
import { cx } from "@/utils/cx";
import { createPublicChannel } from "./channels.functions";
import { listSavedMessages } from "./saved-messages.functions";
import { useCurrentWorkspaceId, useLiveAgents } from "@/features/agents/workspace-agents-realtime";
import { CreateChannelDialog } from "./create-channel-dialog";
import { useChannelUnread } from "./conversation-unread";
import {
  DEFAULT_CONVERSATION_OPEN_MODE,
  conversationOpenMode,
  type ConversationOpenMode,
} from "@/features/settings/conversation-open-mode";

const messagesRoute = getRouteApi("/_app/messages");
const appRoute = getRouteApi("/_app");
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
const OpenModeContext = createContext<ConversationOpenMode>(DEFAULT_CONVERSATION_OPEN_MODE);

type SavedMessageViews = Awaited<ReturnType<typeof listSavedMessages>>;

/** The viewer's Saved list (#127): loader-seeded, re-read after every toggle — one source of
 * truth for the row stars, the sidebar entry, and the Saved view. */
type SavedMessagesState = {
  entries: SavedMessageViews;
  /** The saved message ids a row's star consults. */
  ids: ReadonlySet<string>;
  /** Re-reads the saved list from the server after a save or unsave. */
  refresh: () => Promise<void>;
};

const SavedMessagesContext = createContext<SavedMessagesState | null>(null);

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

/** The user's "When I view a conversation" open behavior, from their saved preferences. */
export function useConversationOpenMode(): ConversationOpenMode {
  return useContext(OpenModeContext);
}

/** The Saved list controls; null where no Chat page is above (rows then offer no save). */
export function useSavedMessages(): SavedMessagesState | null {
  return useContext(SavedMessagesContext);
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
  const { channels, projects, directUnread, directPreferences, viewerId, saved } =
    messagesRoute.useLoaderData();
  const { conversationOpenMode: savedOpenMode } = appRoute.useLoaderData();
  const openMode = conversationOpenMode(savedOpenMode);
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

  const visibleChannels = useMemo(() => channels.filter((listed) => !listed.archived), [channels]);
  const hiddenAgentIds = useMemo(() => new Set(directPreferences.hidden), [directPreferences]);
  const unread = useChannelUnread({
    workspaceId,
    userId: viewerId,
    channels: visibleChannels,
    openConversationId: channel?.channelId,
    // The open DM's own events must not bump its badge: they are being read right now.
    openAgentId: agent?.agentId,
    hiddenAgentIds,
    onClosedConversationActivity: () => void router.invalidate(),
  });
  // Every loader refresh carries the server's own persisted counts; local arithmetic
  // restarts from them (sequence boundaries survive, so no event double-counts). Direct
  // messages are already keyed by Agent id, the same key their realtime signal carries.
  const { counts } = unread;
  const refresh = unread.replace;
  useEffect(() => {
    refresh([
      ...visibleChannels,
      ...Object.entries(directUnread).map(([agentId, unreadCount]) => ({
        id: agentId,
        unreadCount,
      })),
    ]);
  }, [refresh, visibleChannels, directUnread]);
  const controls = useMemo<UnreadControls>(
    () => ({ counts, clear: unread.clear }),
    [counts, unread.clear],
  );
  // Saved (#127): the loader seeds it, every toggle re-reads it — the row stars and the Saved
  // view both follow this one list; router invalidations refresh it with the rest of the loader.
  const [savedEntries, setSavedEntries] = useState<SavedMessageViews>(saved);
  useEffect(() => setSavedEntries(saved), [saved]);
  const reloadSaved = useServerFn(listSavedMessages);
  const savedMessages = useMemo<SavedMessagesState>(
    () => ({
      entries: savedEntries,
      ids: new Set(savedEntries.map((entry) => entry.message.id)),
      refresh: async () => setSavedEntries(await reloadSaved()),
    }),
    [savedEntries, reloadSaved],
  );

  return (
    <ConversationListContext
      value={{
        showList: () => setBrowsing(true),
        closeList: () => setBrowsing(false),
        detailVisible: desktop || !showList,
      }}
    >
      <OpenModeContext value={openMode}>
        <UnreadContext value={controls}>
          <SavedMessagesContext value={savedMessages}>
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
                    directPreferences={directPreferences}
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
          </SavedMessagesContext>
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
