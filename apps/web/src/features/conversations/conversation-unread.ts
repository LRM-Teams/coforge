import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  getUserConversationSubscriptionToken,
  getWorkspaceConversationSubscriptionToken,
} from "#src/features/realtime/realtime.functions";
import {
  decodeMessageAvailableEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "./conversation-realtime";

/**
 * Sidebar unread state for the Chat page (Slack/Discord model): a per-badge count
 * of unread top-level messages, seeded from the server's persisted read cursors and kept
 * live by realtime signals. Opening a conversation clears its badge; every list fetch
 * replaces local arithmetic with the server's own count.
 *
 * A badge key is the conversation id for channels and the Agent id for direct messages (the
 * directory rows' own keys). Channels and direct messages arrive on separate signal channels:
 * the workspace channel carries every channel event, and each user's own channel carries only
 * their direct messages, already labelled with the Agent badge they belong to. Neither path
 * needs a conversation→Agent alias map, so a DM created after the last list fetch still bumps
 * its badge live.
 *
 * Counts live alongside a per-badge sequence high-water mark (`<key>:seq`), so a late or
 * reordered event can never double-count a message the badge already reflects.
 */
export type UnreadCounts = Record<string, number>;

export type UnreadChannel = { id: string; unreadCount?: number };

/** DM unread counts, keyed by the Agent whose sidebar row owns the badge. */
export type DirectUnreadSeed = Readonly<Record<string, number>>;

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
  /** Present on a direct-message signal: the Agent badge this event belongs to. */
  agentId?: string;
};

/**
 * Applies one `message.available.v1` event. Only a top-level message in a listed,
 * not-currently-open conversation bumps the badge: thread replies belong to their thread
 * target (reading a thread never consumes the main conversation's unread), and the open
 * conversation is being read right now. A direct-message event carries its own badge key
 * (`agentId`); a channel event is keyed by its conversation id.
 */
export function applyUnreadEvent(
  current: UnreadCounts,
  event: UnreadEventInput,
  options: {
    openConversationId?: string;
    /** The open direct message's Agent badge key, if a DM is open. */
    openAgentId?: string;
    /** Every conversation id a badge currently stands for (channels; DMs use `agentId`). */
    conversations: ReadonlySet<string>;
  },
): UnreadCounts {
  if (event.conversationId === options.openConversationId) return current;
  if (event.agentId && event.agentId === options.openAgentId) return current;
  if (event.threadRootId) return current;
  const key = event.agentId ?? event.conversationId;
  if (!event.agentId && !options.conversations.has(event.conversationId)) return current;
  const highWater = current[`${key}:seq`] ?? 0;
  if (event.sequence <= highWater) return current;
  return {
    ...current,
    [`${key}:seq`]: event.sequence,
    [key]: (current[key] ?? 0) + 1,
  };
}

/**
 * Whether a new message landed in a chat the sidebar is not showing because the viewer closed it:
 * a channel missing from the listed channels, or a DM whose Agent is in the closed set. Such a
 * message brings the chat back, so the sidebar re-reads its list. Thread replies never do.
 */
export function activityInClosedConversation(
  event: UnreadEventInput,
  listed: { conversations: ReadonlySet<string>; hiddenAgentIds: ReadonlySet<string> },
): boolean {
  if (event.threadRootId) return false;
  if (event.agentId) return listed.hiddenAgentIds.has(event.agentId);
  return !listed.conversations.has(event.conversationId);
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
 * everything shown in the main pane". Thread replies never advance it. Shared by
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
 * Persists a conversation-level read cursor, retrying a transient failure once. Both mark-read
 * call sites used to swallow every failure with `.catch(() => {})`, so a flaky POST left the
 * cursor stuck at zero and the pane kept reopening at the same unread boundary with nothing in
 * the console to show why. One retry clears the transient case; a persistent one is logged with
 * the label of the surface that failed, so it is diagnosable from devtools.
 */
export async function persistReadCursor(
  call: () => Promise<unknown>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await call();
      return;
    } catch (error) {
      if (attempt === 1) {
        console.warn(`[coforge] read cursor did not persist (${label})`, error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

/**
 * A loader refresh replaced the server's own counts; local arithmetic restarts from them.
 * Sequence boundaries survive the refresh, so a stale event that raced the fetch cannot
 * double-count a message the server already counted.
 *
 * `suppressKeys` names the conversations the viewer is looking at right now (the open channel
 * and the open DM). They keep their boundary but lose their count, exactly like
 * `applyUnreadEvent`: without this, a refresh in the `newest-unread` preference — where the
 * server cursor has deliberately not advanced yet — would re-raise the badge of the very
 * conversation being read. Leaving the conversation re-seeds it from the server.
 */
export function replaceUnreadCounts(
  current: UnreadCounts,
  entries: readonly UnreadChannel[],
  suppressKeys: ReadonlySet<string> = new Set<string>(),
): UnreadCounts {
  const boundaries: UnreadCounts = {};
  for (const entry of entries) {
    const boundary = current[`${entry.id}:seq`];
    if (boundary !== undefined) boundaries[`${entry.id}:seq`] = boundary;
  }
  const seeded = seedUnreadCounts(entries);
  for (const key of suppressKeys) delete seeded[key];
  return { ...seeded, ...boundaries };
}

export type UnreadState = {
  counts: UnreadCounts;
  clear: (key: string, readThroughSequence?: number) => void;
  replace: (entries: readonly UnreadChannel[]) => void;
};

/**
 * The Chat page's two signal subscriptions and its unread-count state. Renders nothing: the
 * directory reads `counts`, the conversation routes call `clear`, and every loader refresh
 * flows through `replace`. Both subscriptions ride the `_app` layout's one Centrifuge
 * connection; neither opens a WebSocket of its own.
 */
export function useChannelUnread({
  workspaceId,
  userId,
  channels,
  openConversationId,
  openAgentId,
  hiddenAgentIds,
  onClosedConversationActivity,
}: {
  workspaceId?: string;
  /** The viewer, whose own direct-message signal channel carries their DM badges. */
  userId?: string;
  /** Channel rows currently listed; channel events for anything else are ignored. */
  channels: readonly UnreadChannel[];
  /** The conversation currently shown in the detail pane, if any. */
  openConversationId?: string;
  /** The Agent badge of the direct message currently shown, if a DM is open. */
  openAgentId?: string;
  /** Agents whose DM the viewer closed; the sidebar leaves those rows out. */
  hiddenAgentIds: ReadonlySet<string>;
  /** A new message arrived in a closed chat: the sidebar re-reads its list to bring it back. */
  onClosedConversationActivity: () => void;
}): UnreadState {
  const [counts, setCounts] = useState<UnreadCounts>({});
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  const refs = useRef({
    channels,
    openConversationId,
    openAgentId,
    hiddenAgentIds,
    onClosedConversationActivity,
  });
  refs.current = {
    channels,
    openConversationId,
    openAgentId,
    hiddenAgentIds,
    onClosedConversationActivity,
  };

  const onPublication = useCallback((publication: { data: unknown }) => {
    try {
      const event = decodeMessageAvailableEvent(publication.data);
      const {
        channels: channelRows,
        openConversationId: open,
        openAgentId: openAgent,
        hiddenAgentIds: hiddenAgents,
        onClosedConversationActivity: reopenFromActivity,
      } = refs.current;
      const conversations = new Set(channelRows.map((channel) => channel.id));
      if (activityInClosedConversation(event, { conversations, hiddenAgentIds: hiddenAgents }))
        reopenFromActivity();
      setCounts((current) =>
        applyUnreadEvent(current, event, {
          conversations,
          openConversationId: open,
          openAgentId: openAgent,
        }),
      );
    } catch {
      // An undecodable publication never breaks the badge; reconciliation repairs state.
    }
  }, []);

  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    getToken: workspaceId ? getWorkspaceToken : undefined,
    onPublication,
  });
  useRealtimeSubscription({
    channel: userId ? userConversationChannel(userId) : undefined,
    getToken: userId ? getUserToken : undefined,
    onPublication,
  });

  const clear = useCallback(
    (key: string, readThroughSequence?: number) =>
      setCounts((current) => clearUnread(current, key, readThroughSequence)),
    [],
  );
  const replace = useCallback((next: readonly UnreadChannel[]) => {
    // The conversation on screen keeps no badge, exactly like a live event for it: in
    // `newest-unread` the server cursor deliberately lags, so seeding it here would
    // re-raise the badge of the conversation being read.
    const { openConversationId: open, openAgentId: openAgent } = refs.current;
    const suppressed = new Set<string>();
    if (open) suppressed.add(open);
    if (openAgent) suppressed.add(openAgent);
    setCounts((current) => replaceUnreadCounts(current, next, suppressed));
  }, []);
  return { counts, clear, replace };
}
