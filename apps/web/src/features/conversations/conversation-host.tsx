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
import { getRouteApi } from "@tanstack/react-router";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  DEFAULT_CONVERSATION_OPEN_MODE,
  conversationOpenMode,
  type ConversationOpenMode,
} from "#src/features/settings/conversation-open-mode";
import type { ChannelSuggestion } from "./reference-completion";
import { listSavedMessages, saveMessage, unsaveMessage } from "./saved-messages.functions";
import {
  materializeSavedMessages,
  savedMessagesQueryKey,
  savedMessagesStore,
  type SavedEntry,
  type SavedMessagesStore,
} from "./saved-messages-collection";

const appRoute = getRouteApi("/_app");

/** The viewer's Saved list (#127), one TanStack DB collection behind the row stars, the sidebar
 * entry, and the Saved view (`saved-messages-collection.ts`). Saves and unsaves show at once and
 * roll back when the server refuses them. */
type SavedMessagesState = {
  store: SavedMessagesStore;
  /** Resolves once the server has the save; rejects (after rolling back) when it fails. */
  save: (saved: SavedEntry) => Promise<void>;
  unsave: (messageId: string) => Promise<void>;
};

const OpenModeContext = createContext<ConversationOpenMode>(DEFAULT_CONVERSATION_OPEN_MODE);
const SavedMessagesContext = createContext<SavedMessagesState | null>(null);
const ChannelsContext = createContext<readonly ChannelSuggestion[] | undefined>(undefined);

/**
 * What a conversation reads from the page hosting it (Chat, the search preview): the viewer's
 * "When I view a conversation" open mode and Saved list, and the Workspace's channels (every
 * channel by id, closed ones included: the authority a body's channel links check), each seeded
 * by the hosting page's loader. The sidebar's unread badges stay Chat's own.
 */
export function ConversationHostProvider({
  saved,
  channels,
  children,
}: {
  saved: SavedEntry[];
  channels: readonly ChannelSuggestion[];
  children: ReactNode;
}) {
  const { conversationOpenMode: savedOpenMode } = appRoute.useLoaderData();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Saved (#127): the loader seeds the collection; a toggle changes it at once and persists in
  // the background. A router invalidation's fresh list reaches it through its Query.
  const queryClient = useQueryClient();
  const [dbClient] = useState(() => new DbClient({ queryClient }));
  // The collection is seeded once per Workspace from the list at hand; later loader lists go
  // through its Query (the effect below), never by re-seeding.
  const seededSaved = useRef(saved);
  const savedMessages = useMemo<SavedMessagesState>(() => {
    const collection = materializeSavedMessages(dbClient, workspaceId, seededSaved.current, {
      list: () => listSavedMessages(),
      save: (target) => saveMessage({ data: target }),
      unsave: (target) => unsaveMessage({ data: target }),
    });
    const store = savedMessagesStore(collection);
    return { store, save: store.save, unsave: store.unsave };
  }, [dbClient, workspaceId]);
  useEffect(() => {
    if (saved === seededSaved.current) return;
    queryClient.setQueryData(savedMessagesQueryKey(workspaceId), saved);
  }, [queryClient, workspaceId, saved]);
  return (
    <OpenModeContext value={conversationOpenMode(savedOpenMode)}>
      <SavedMessagesContext value={savedMessages}>
        <ChannelsContext value={channels}>{children}</ChannelsContext>
      </SavedMessagesContext>
    </OpenModeContext>
  );
}

/** The user's "When I view a conversation" open behavior, from their saved preferences. */
export function useConversationOpenMode(): ConversationOpenMode {
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

/** The Workspace's channels from the hosting page; undefined outside a conversation host. */
export function useConversationHostChannels(): readonly ChannelSuggestion[] | undefined {
  return useContext(ChannelsContext);
}

/** The Saved list controls; null where no conversation host is above (rows then offer no save). */
export function useSavedMessages(): SavedMessagesState | null {
  return useContext(SavedMessagesContext);
}

const NO_SAVED_ENTRIES: SavedEntry[] = [];
const noSubscription = () => () => {};

/** The Saved list, newest save first; undefined where no conversation host is above. */
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
