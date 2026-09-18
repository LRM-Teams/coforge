import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useRealtimeSubscription } from "../realtime/browser-realtime";
import { getWorkspaceConversationSubscriptionToken } from "../realtime/realtime.functions";
import { decodeMessageAvailableEvent, workspaceConversationChannel } from "./conversation-realtime";

/**
 * Sidebar unread state for the Chat page (ADR 0046, Slack/Discord model): a per-badge count
 * of unread top-level messages, seeded from the server's persisted read cursors and kept
 * live by the workspace conversation signal channel. Opening a conversation clears its
 * badge; every list fetch replaces local arithmetic with the server's own count.
 *
 * A badge key is the conversation id for channels and the Agent id for direct messages (the
 * directory rows' own keys). Realtime events carry only the conversation id, so the seed
 * payload also supplies the conversation→Agent alias map for DMs; a conversation the alias
 * map does not know yet (a DM never opened since the last fetch) still resolves through the
 * latest fetch at event time via the ref.
 *
 * Counts live alongside a per-badge sequence high-water mark (`<key>:seq`), so a late or
 * reordered event can never double-count a message the badge already reflects.
 */
export type UnreadCounts = Record<string, number>;

export type UnreadChannel = { id: string; unreadCount?: number };

export type DirectUnreadSeed = {
  counts: Readonly<Record<string, number>>;
  conversationAgentIds: Readonly<Record<string, string>>;
};

/** Seeds local state from the server's list payload. */
export function seedUnreadCounts(entries: readonly UnreadChannel[]): UnreadCounts {
  const next: UnreadCounts = {};
  for (const entry of entries)
    if (entry.unreadCount && entry.unreadCount > 0) next[entry.id] = entry.unreadCount;
  return next;
}

export type UnreadEventInput = {
  conversationId: string;
  sequence: number;
  threadRootId?: string;
};

/**
 * Applies one `message.available.v1` event. Only a top-level message in a listed,
 * not-currently-open conversation bumps the badge: thread replies belong to their thread
 * target (reading a thread never consumes the main conversation's unread), and the open
 * conversation is being read right now.
 */
export function applyUnreadEvent(
  current: UnreadCounts,
  event: UnreadEventInput,
  options: {
    openConversationId?: string;
    /** Every conversation id a badge currently stands for (channels directly; DMs aliased). */
    conversations: ReadonlySet<string>;
    /** Conversation id → Agent id for DM badges, from the latest list fetch. */
    conversationAgentIds: Readonly<Record<string, string>>;
  },
): UnreadCounts {
  if (event.conversationId === options.openConversationId) return current;
  if (!options.conversations.has(event.conversationId)) return current;
  if (event.threadRootId) return current;
  const key = options.conversationAgentIds[event.conversationId] ?? event.conversationId;
  const highWater = current[`${key}:seq`] ?? 0;
  if (event.sequence <= highWater) return current;
  return {
    ...current,
    [`${key}:seq`]: event.sequence,
    [key]: (current[key] ?? 0) + 1,
  };
}

/** A conversation was read: clear its badge and remember the boundary it was read to. */
export function clearUnread(
  current: UnreadCounts,
  key: string,
  readThroughSequence?: number,
): UnreadCounts {
  const boundary = readThroughSequence ?? current[`${key}:seq`];
  if (!(key in current) && boundary === undefined) return current;
  const next = { ...current };
  delete next[key];
  if (boundary !== undefined && (next[`${key}:seq`] ?? 0) < boundary) next[`${key}:seq`] = boundary;
  return next;
}

/**
 * The highest top-level sequence in a loaded conversation page — the boundary "I have read
 * everything shown in the main pane". Thread replies never advance it (ADR 0046). Shared by
 * the channel and DM routes so the two mark-read paths cannot drift.
 */
export function latestTopLevelSequence(
  messages: readonly { sequence: number; threadRootId?: string | null }[],
): number {
  return messages.reduce(
    (latest, message) => (message.threadRootId ? latest : Math.max(latest, message.sequence)),
    0,
  );
}

/**
 * A loader refresh replaced the server's own counts; local arithmetic restarts from them.
 * Sequence boundaries survive the refresh, so a stale event that raced the fetch cannot
 * double-count a message the server already counted.
 */
export function replaceUnreadCounts(
  current: UnreadCounts,
  entries: readonly UnreadChannel[],
): UnreadCounts {
  const boundaries: UnreadCounts = {};
  for (const entry of entries) {
    const boundary = current[`${entry.id}:seq`];
    if (boundary !== undefined) boundaries[`${entry.id}:seq`] = boundary;
  }
  return { ...seedUnreadCounts(entries), ...boundaries };
}

export type UnreadState = {
  counts: UnreadCounts;
  clear: (key: string, readThroughSequence?: number) => void;
  replace: (entries: readonly UnreadChannel[]) => void;
};

/**
 * The Chat page's one workspace conversation subscription and its unread-count state.
 * Renders nothing: the directory reads `counts`, the conversation routes call `clear`,
 * and every loader refresh flows through `replace`.
 */
export function useChannelUnread({
  workspaceId,
  channels,
  directUnread,
  openConversationId,
}: {
  workspaceId?: string;
  /** Channel rows currently listed; events for anything else are ignored. */
  channels: readonly UnreadChannel[];
  /** The current DM seed (counts keyed by conversation id, plus its Agent alias map). */
  directUnread: DirectUnreadSeed;
  /** The conversation currently shown in the detail pane, if any. */
  openConversationId?: string;
}): UnreadState {
  const [counts, setCounts] = useState<UnreadCounts>({});
  const getToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const refs = useRef({ channels, directUnread, openConversationId });
  refs.current = { channels, directUnread, openConversationId };

  const onPublication = useCallback((publication: { data: unknown }) => {
    try {
      const event = decodeMessageAvailableEvent(publication.data);
      const {
        channels: channelRows,
        directUnread: direct,
        openConversationId: open,
      } = refs.current;
      const conversationAgentIds = direct.conversationAgentIds;
      // Every conversation a badge can stand for: listed channels plus the DMs the latest
      // fetch counted. A DM created after that fetch has no badge until the next one.
      const conversations = new Set([
        ...channelRows.map((channel) => channel.id),
        ...Object.keys(conversationAgentIds),
      ]);
      setCounts((current) =>
        applyUnreadEvent(current, event, {
          conversations,
          conversationAgentIds,
          openConversationId: open,
        }),
      );
    } catch {
      // An undecodable publication never breaks the badge; reconciliation repairs state.
    }
  }, []);

  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    getToken: workspaceId ? getToken : undefined,
    onPublication,
  });

  const clear = useCallback(
    (key: string, readThroughSequence?: number) =>
      setCounts((current) => clearUnread(current, key, readThroughSequence)),
    [],
  );
  const replace = useCallback(
    (next: readonly UnreadChannel[]) => setCounts((current) => replaceUnreadCounts(current, next)),
    [],
  );
  return { counts, clear, replace };
}
