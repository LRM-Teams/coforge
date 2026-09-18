import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useRealtimeSubscription } from "../realtime/browser-realtime";
import { getWorkspaceConversationSubscriptionToken } from "../realtime/realtime.functions";
import { decodeMessageAvailableEvent, workspaceConversationChannel } from "./conversation-realtime";

/**
 * Sidebar unread state for the Chat page's channel list (ADR 0043, Slack/Discord model):
 * a per-channel count of unread top-level messages, seeded from the server's persisted
 * read cursors and kept live by the workspace conversation signal channel. Opening a
 * channel clears its badge; every list fetch replaces local arithmetic with the server's
 * own count.
 *
 * Counts live alongside a per-conversation sequence high-water mark (`<id>:seq`), so a
 * late or reordered event can never double-count a message the badge already reflects.
 */
export type UnreadCounts = Record<string, number>;

export type UnreadChannel = { id: string; unreadCount?: number };

/** Seeds local state from the server's list payload. */
export function seedUnreadCounts(channels: readonly UnreadChannel[]): UnreadCounts {
  const next: UnreadCounts = {};
  for (const channel of channels)
    if (channel.unreadCount && channel.unreadCount > 0) next[channel.id] = channel.unreadCount;
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
 * target (reading a thread never consumes channel unread), and the open conversation is
 * being read right now.
 */
export function applyUnreadEvent(
  current: UnreadCounts,
  event: UnreadEventInput,
  options: { openConversationId?: string; channels: ReadonlySet<string> },
): UnreadCounts {
  if (!options.channels.has(event.conversationId)) return current;
  if (event.conversationId === options.openConversationId) return current;
  if (event.threadRootId) return current;
  const highWater = current[`${event.conversationId}:seq`] ?? 0;
  if (event.sequence <= highWater) return current;
  return {
    ...current,
    [`${event.conversationId}:seq`]: event.sequence,
    [event.conversationId]: (current[event.conversationId] ?? 0) + 1,
  };
}

/** A conversation was read: clear its badge and remember the boundary it was read to. */
export function clearUnread(
  current: UnreadCounts,
  conversationId: string,
  readThroughSequence?: number,
): UnreadCounts {
  const boundary = readThroughSequence ?? current[`${conversationId}:seq`];
  if (!(conversationId in current) && boundary === undefined) return current;
  const next = { ...current };
  delete next[conversationId];
  if (boundary !== undefined && (next[`${conversationId}:seq`] ?? 0) < boundary)
    next[`${conversationId}:seq`] = boundary;
  return next;
}

/**
 * The loader's channel list replaced the server's own counts; local arithmetic restarts
 * from them. Sequence boundaries survive the refresh, so a stale event that raced the
 * fetch cannot double-count a message the server already counted.
 */
export function replaceUnreadCounts(
  current: UnreadCounts,
  channels: readonly UnreadChannel[],
): UnreadCounts {
  const boundaries: UnreadCounts = {};
  for (const channel of channels) {
    const boundary = current[`${channel.id}:seq`];
    if (boundary !== undefined) boundaries[`${channel.id}:seq`] = boundary;
  }
  return { ...seedUnreadCounts(channels), ...boundaries };
}

export type UnreadState = {
  counts: UnreadCounts;
  clear: (conversationId: string, readThroughSequence?: number) => void;
  replace: (channels: readonly UnreadChannel[]) => void;
};

/**
 * The Chat page's one workspace conversation subscription and its unread-count state.
 * Renders nothing: the directory reads `counts`, the conversation routes call `clear`,
 * and every loader refresh flows through `replace`.
 */
export function useChannelUnread({
  workspaceId,
  channels,
  openConversationId,
}: {
  workspaceId?: string;
  /** Channel ids currently listed; events for anything else are ignored. */
  channels: readonly UnreadChannel[];
  /** The conversation currently shown in the detail pane, if any. */
  openConversationId?: string;
}): UnreadState {
  const [counts, setCounts] = useState<UnreadCounts>({});
  const getToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const refs = useRef({ channels, openConversationId });
  refs.current = { channels, openConversationId };

  const onPublication = useCallback((publication: { data: unknown }) => {
    try {
      const event = decodeMessageAvailableEvent(publication.data);
      setCounts((current) =>
        applyUnreadEvent(current, event, {
          openConversationId: refs.current.openConversationId,
          channels: new Set(refs.current.channels.map((channel) => channel.id)),
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
    (conversationId: string, readThroughSequence?: number) =>
      setCounts((current) => clearUnread(current, conversationId, readThroughSequence)),
    [],
  );
  const replace = useCallback(
    (next: readonly UnreadChannel[]) => setCounts((current) => replaceUnreadCounts(current, next)),
    [],
  );
  return { counts, clear, replace };
}
