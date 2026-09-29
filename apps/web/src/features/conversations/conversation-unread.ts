import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  getUserConversationSubscriptionToken,
  getWorkspaceConversationSubscriptionToken,
} from "#src/features/realtime/realtime.functions";
import {
  decodeChannelCreatedEvent,
  decodeChannelUpdatedEvent,
  decodeMessageAvailableEvent,
  decodeViewerEvent,
  userConversationChannel,
  workspaceConversationChannel,
  type ViewerEvent,
} from "./conversation-realtime";

/**
 * Sidebar unread state for the Chat page (Slack/Discord model): a per-badge count
 * of unread top-level messages, seeded from the server's persisted read cursors and kept
 * live by realtime signals. Opening a conversation clears its badge; every list fetch
 * replaces local arithmetic with the server's own count.
 *
 * A badge key is the conversation id, for channels and direct messages alike (the directory
 * rows' own keys). Channels and direct messages arrive on separate signal channels: the
 * workspace channel carries every channel event, and each user's own channel carries only their
 * direct messages, each naming who is on the other side. A DM event counts without a listed
 * conversation, so a DM created after the last list fetch still bumps its badge live.
 *
 * Counts live alongside a per-badge sequence high-water mark (`<key>:seq`), so a late or
 * reordered event can never double-count a message the badge already reflects.
 */
export type UnreadCounts = Record<string, number>;

export type UnreadChannel = { id: string; unreadCount?: number };

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
  /** Present on a signal of a DM with an Agent: that Agent. */
  agentId?: string;
  /** Present on a signal of a DM between members: the other member. */
  peerUserId?: string;
};

/**
 * Applies one `message.available.v1` event. Only a top-level message in a listed,
 * not-currently-open conversation bumps the badge: thread replies belong to their thread
 * target (reading a thread never consumes the main conversation's unread), and the open
 * conversation is being read right now. Every badge is keyed by its conversation id; a channel
 * event counts only for a listed channel, a direct-message event (it names the Agent or member on
 * the other side) always.
 */
export function applyUnreadEvent(
  current: UnreadCounts,
  event: UnreadEventInput,
  options: {
    openConversationId?: string;
    /** Every listed channel's conversation id. */
    conversations: ReadonlySet<string>;
  },
): UnreadCounts {
  if (event.conversationId === options.openConversationId) return current;
  if (event.threadRootId) return current;
  const key = event.conversationId;
  const direct = event.agentId !== undefined || event.peerUserId !== undefined;
  if (!direct && !options.conversations.has(key)) return current;
  const highWater = current[`${key}:seq`] ?? 0;
  if (event.sequence <= highWater) return current;
  return {
    ...current,
    [`${key}:seq`]: event.sequence,
    [key]: (current[key] ?? 0) + 1,
  };
}

/**
 * Whether a new message landed in a chat the sidebar is not showing: one the viewer closed, or a DM
 * that started after the list was read. Such a message brings the chat in, so the sidebar re-reads
 * its list. Thread replies never do.
 */
export function activityInClosedConversation(
  event: UnreadEventInput,
  listed: ReadonlySet<string>,
): boolean {
  return !event.threadRootId && !listed.has(event.conversationId);
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

/** A viewer event that moved a read cursor, carrying the count it left. */
export type MarkedEvent = Extract<ViewerEvent, { unreadCount: number }>;

/**
 * The viewer's read cursor in a channel or DM moved (`channel.marked.v1`, `dm.marked.v1`): read or
 * marked unread here, in another tab or on another device. The badge takes the count the move
 * left, as Slack's `channel_marked` and `im_marked` set `unread_count`; the sequence boundary
 * stays. The chat on screen keeps no badge, like `applyUnreadEvent`.
 */
export function applyMarked(
  current: UnreadCounts,
  event: MarkedEvent,
  options: { openConversationId?: string },
): UnreadCounts {
  const key = event.conversationId;
  if (key === options.openConversationId) return current;
  if ((current[key] ?? 0) === event.unreadCount) return current;
  const next = { ...current };
  if (event.unreadCount > 0) next[key] = event.unreadCount;
  else delete next[key];
  return next;
}

/** A list the Chat page keeps: the sidebar's channel rows or DM rows, or every channel's name
 * (what a body's channel links and the composer's `#` list read). */
export type SidebarList = "channels" | "dms" | "channelNames";

/**
 * Which of the sidebar's lists a viewer event makes stale, for the page to re-read those alone. A
 * read carries its own count (`applyMarked`) and needs none; pins are one order across
 * channels and DMs, so they touch both.
 */
export function sidebarListsChangedBy(event: ViewerEvent): readonly SidebarList[] {
  if ("unreadCount" in event) return [];
  if (event.type === "pref.changed.v1")
    return event.name === "pins" ? ["channels", "dms"] : ["channels"];
  return event.type.startsWith("dm.") ? ["dms"] : ["channels"];
}

/**
 * Which lists a Workspace-channel publication makes stale: a channel created or changed anywhere in
 * the Workspace (`channel.created.v1`, `channel.updated.v1`) makes the channel list and the channel
 * names stale; anything else (a message signal) is undefined.
 */
export function workspaceSignalLists(data: unknown): readonly SidebarList[] | undefined {
  if (decodeChannelCreatedEvent(data)) return ["channels", "channelNames"];
  try {
    decodeChannelUpdatedEvent(data);
    return ["channels", "channelNames"];
  } catch {
    return undefined;
  }
}

/**
 * Coalesces sidebar re-reads: lists named before a re-read starts go into it, and lists named
 * while one is running go into a single re-read after it, so a burst of events costs at most one
 * read in flight and one queued. Each call settles once a re-read covering its lists has.
 */
export function sidebarRefreshQueue(read: (lists: ReadonlySet<SidebarList>) => Promise<void>) {
  let running: Promise<void> = Promise.resolve();
  let queued: { lists: Set<SidebarList>; done: Promise<void> } | undefined;
  return (lists: readonly SidebarList[]): Promise<void> => {
    if (!queued) {
      const batch = new Set<SidebarList>();
      const done = running.then(() => {
        queued = undefined;
        return read(batch);
      });
      running = done.catch(() => undefined);
      queued = { lists: batch, done };
    }
    for (const list of lists) queued.lists.add(list);
    return queued.done;
  };
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
 * `suppressKeys` names the conversation the viewer is looking at right now (the open channel or
 * DM). It keeps its boundary but loses its count, exactly like
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
 * flows through `replace`. Both subscriptions ride the Workspace layout's one Centrifuge
 * connection; neither opens a WebSocket of its own.
 */
export function useChannelUnread({
  workspaceId,
  userId,
  channels,
  openConversationId,
  listedConversationIds,
  onClosedConversationActivity,
  onSidebarListsChanged,
}: {
  workspaceId?: string;
  /** The viewer, whose own direct-message signal channel carries their DM badges. */
  userId?: string;
  /** Channel rows currently listed; channel events for anything else are ignored. */
  channels: readonly UnreadChannel[];
  /** The channel or DM currently shown in the detail pane, if any. */
  openConversationId?: string;
  /** Every chat the sidebar lists, channels and DMs, by conversation id. */
  listedConversationIds: ReadonlySet<string>;
  /** A new message arrived in a closed chat: the sidebar re-reads its list to bring it back. */
  onClosedConversationActivity: () => void;
  /** These lists are stale: a channel was created, renamed, described, archived or unarchived
   * (`channel.created.v1`, `channel.updated.v1`), or the viewer's own place in a chat changed
   * elsewhere (`ViewerEvent`). */
  onSidebarListsChanged: (lists: readonly SidebarList[]) => void;
}): UnreadState {
  const [counts, setCounts] = useState<UnreadCounts>({});
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  const refs = useRef({
    channels,
    openConversationId,
    listedConversationIds,
    onClosedConversationActivity,
    onSidebarListsChanged,
  });
  refs.current = {
    channels,
    openConversationId,
    listedConversationIds,
    onClosedConversationActivity,
    onSidebarListsChanged,
  };

  const onPublication = useCallback((publication: { data: unknown }) => {
    const lists = workspaceSignalLists(publication.data);
    if (lists) {
      refs.current.onSidebarListsChanged(lists);
      return;
    }
    try {
      const event = decodeMessageAvailableEvent(publication.data);
      const {
        channels: channelRows,
        openConversationId: open,
        listedConversationIds: listed,
        onClosedConversationActivity: reopenFromActivity,
      } = refs.current;
      const conversations = new Set(channelRows.map((channel) => channel.id));
      if (activityInClosedConversation(event, listed)) reopenFromActivity();
      setCounts((current) =>
        applyUnreadEvent(current, event, {
          conversations,
          openConversationId: open,
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
  // The viewer's own channel also carries their `ViewerEvent`s; the Workspace channel never does.
  const onUserPublication = useCallback(
    (publication: { data: unknown }) => {
      const event = decodeViewerEvent(publication.data);
      if (!event) return onPublication(publication);
      if ("unreadCount" in event)
        setCounts((current) =>
          applyMarked(current, event, {
            openConversationId: refs.current.openConversationId,
          }),
        );
      const lists = sidebarListsChangedBy(event);
      if (lists.length > 0) refs.current.onSidebarListsChanged(lists);
    },
    [onPublication],
  );
  useRealtimeSubscription({
    channel: userId ? userConversationChannel(userId) : undefined,
    getToken: userId ? getUserToken : undefined,
    onPublication: onUserPublication,
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
    const open = refs.current.openConversationId;
    setCounts((current) => replaceUnreadCounts(current, next, new Set(open ? [open] : [])));
  }, []);
  return { counts, clear, replace };
}
