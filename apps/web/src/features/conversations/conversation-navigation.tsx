import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DbClient } from "@tanstack/react-db";
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
import { listSavedMessages, saveMessage, unsaveMessage } from "./saved-messages.functions";
import {
  materializeSavedMessages,
  savedMessagesQueryKey,
  savedMessagesStore,
  type SavedEntry,
  type SavedMessagesStore,
} from "./saved-messages-collection";
import {
  useCurrentWorkspaceId,
  useLiveAgents,
} from "#src/features/agents/workspace-agents-realtime";
import { CreateChannelDialog } from "./create-channel-dialog";
import { rememberConversation } from "./last-conversation";
import { useChannelUnread } from "./conversation-unread";
import { useSidebarLists } from "./sidebar-lists";
import {
  DEFAULT_CONVERSATION_OPEN_MODE,
  conversationOpenMode,
  type ConversationOpenMode,
} from "#src/features/settings/conversation-open-mode";

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

/** The viewer's Saved list (#127), one TanStack DB collection behind the row stars, the sidebar
 * entry, and the Saved view (`saved-messages-collection.ts`). Saves and unsaves show at once and
 * roll back when the server refuses them. */
type SavedMessagesState = {
  store: SavedMessagesStore;
  /** Resolves once the server has the save; rejects (after rolling back) when it fails. */
  save: (saved: SavedEntry) => Promise<void>;
  unsave: (messageId: string) => Promise<void>;
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

const NO_SAVED_ENTRIES: SavedEntry[] = [];
const noSubscription = () => () => {};

/** The Saved list, newest save first; undefined where no Chat page is above. */
export function useSavedEntries(): SavedEntry[] | undefined {
  const saved = useContext(SavedMessagesContext);
  const entries = useSyncExternalStore(
    saved?.store.subscribe ?? noSubscription,
    () => saved?.store.entries() ?? NO_SAVED_ENTRIES,
    () => saved?.store.entries() ?? NO_SAVED_ENTRIES,
  );
  return saved ? entries : undefined;
}

/** Whether one message is saved; a row re-renders only when its own answer changes. */
export function useIsMessageSaved(messageId: string): boolean {
  const saved = useContext(SavedMessagesContext);
  return useSyncExternalStore(
    saved?.store.subscribe ?? noSubscription,
    () => saved?.store.has(messageId) ?? false,
    () => saved?.store.has(messageId) ?? false,
  );
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
  const { projects, saved } = messagesRoute.useLoaderData();
  const { channels, directUnread, directPreferences, viewerId } = useSidebarLists();
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
  const hiddenAgentIds = useMemo(() => new Set(directPreferences.hidden), [directPreferences]);
  const closedChatRefresh = useRef<"idle" | "running" | "queued">("idle");
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
  });
  // Every list read carries the server's own persisted counts; local arithmetic restarts from
  // them (sequence boundaries survive, so no event double-counts). Direct messages are already
  // keyed by Agent id, the same key their realtime signal carries. Only a change in the counts
  // themselves re-seeds: a pin or a drag changes the rows but not their counts.
  const { counts } = unread;
  const refresh = unread.replace;
  const seed = useMemo(
    () => [
      ...visibleChannels.map((listed) => ({ id: listed.id, unreadCount: listed.unreadCount })),
      ...Object.entries(directUnread).map(([agentId, unreadCount]) => ({
        id: agentId,
        unreadCount,
      })),
    ],
    [visibleChannels, directUnread],
  );
  const seedKey = seed.map((entry) => `${entry.id}:${entry.unreadCount}`).join(",");
  useEffect(() => {
    refresh(seed);
  }, [refresh, seedKey]);
  const controls = useMemo<UnreadControls>(
    () => ({ counts, clear: unread.clear }),
    [counts, unread.clear],
  );
  // Saved (#127): the loader seeds the collection; a toggle changes it at once and persists in
  // the background. A router invalidation's fresh list reaches it through its Query.
  const queryClient = useQueryClient();
  const [dbClient] = useState(() => new DbClient({ queryClient }));
  const savedWorkspaceId = workspaceId ?? "";
  // The collection is seeded once per Workspace from the list at hand; later loader lists go
  // through its Query (the effect below), never by re-seeding.
  const seededSaved = useRef(saved);
  const savedMessages = useMemo<SavedMessagesState>(() => {
    const collection = materializeSavedMessages(dbClient, savedWorkspaceId, seededSaved.current, {
      list: () => listSavedMessages(),
      save: (target) => saveMessage({ data: target }),
      unsave: (target) => unsaveMessage({ data: target }),
    });
    const store = savedMessagesStore(collection);
    return { store, save: store.save, unsave: store.unsave };
  }, [dbClient, savedWorkspaceId]);
  useEffect(() => {
    if (saved === seededSaved.current) return;
    queryClient.setQueryData(savedMessagesQueryKey(savedWorkspaceId), saved);
  }, [queryClient, savedWorkspaceId, saved]);

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
