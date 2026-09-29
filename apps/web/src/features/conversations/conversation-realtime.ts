import { utf8Decoder } from "@lrm/coforge-sdk/internal";
export const conversationRealtimeChannel = (conversationId: string) => `chat:${conversationId}`;

/**
 * Workspace-level signal fan-out for conversation activity. Carries the same
 * versioned `message.available.v1` payloads as `chat:<conversationId>`, but
 * one subscription per open Workspace keeps the sidebar unread counts live
 * without holding a per-conversation subscription for every channel in the
 * list. It also carries `channel.updated.v1`, so the sidebar re-reads a renamed, deleted
 * or archived channel, and `task.changed.v1` (`features/tasks/task-realtime.ts`), so an open
 * Tasks page updates the rows a Task write changed. Authorization mirrors the status/activity workspace channels: the
 * subscription token is issued only to Workspace members.
 */
export const workspaceConversationChannel = (workspaceId: string) =>
  `chat:workspace:${workspaceId}`;

/**
 * The viewer's own direct-message signal channel. A DM event is published here (and on its
 * conversation channel) instead of the workspace channel, so direct-message metadata never
 * reaches every Workspace member; each publication names who is on the other side, which is how
 * the sidebar tells a DM's event from a channel's. It also carries the viewer's own
 * `ViewerEvent`s (their reads, joins, closes, mutes and pins, wherever they made them).
 */
export const userConversationChannel = (userId: string) => `chat:user:${userId}`;

export type MessageAvailableEvent = {
  type: "message.available.v1";
  conversationId: string;
  messageId: string;
  sequence: number;
  /** The message's Workspace, so workspace-channel subscribers can scope the event. */
  workspaceId?: string;
  /** Set only for a thread reply: reading a thread consumes thread unread, never channel unread. */
  threadRootId?: string;
  /** Set only for a direct message with an Agent: that Agent. */
  agentId?: string;
  /**
   * Set only on a member's own signal channel for a direct conversation between people: the
   * other member (the member themself in their own conversation).
   */
  peerUserId?: string;
  /**
   * Set only for a message a person sent from the browser: the send's idempotency key
   * (`requestId`). The sender's own page shows the message greyed the moment it is submitted and
   * uses this to replace that pending copy with the real message, even when this signal outruns
   * the send's own response. Meaningless to anyone else, who ignores it.
   */
  requestId?: string;
};

export function decodeMessageAvailableEvent(value: unknown): MessageAvailableEvent {
  if (value instanceof Uint8Array)
    return decodeMessageAvailableEvent(JSON.parse(utf8Decoder.decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const conversationId = Reflect.get(value, "conversationId");
  const messageId = Reflect.get(value, "messageId");
  const sequence = Reflect.get(value, "sequence");
  const workspaceId = Reflect.get(value, "workspaceId");
  const threadRootId = Reflect.get(value, "threadRootId");
  const agentId = Reflect.get(value, "agentId");
  const peerUserId = Reflect.get(value, "peerUserId");
  const requestId = Reflect.get(value, "requestId");
  if (
    type !== "message.available.v1" ||
    typeof conversationId !== "string" ||
    !conversationId ||
    typeof messageId !== "string" ||
    !messageId ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    (workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId)) ||
    (threadRootId !== undefined && (typeof threadRootId !== "string" || !threadRootId)) ||
    (agentId !== undefined && (typeof agentId !== "string" || !agentId)) ||
    (peerUserId !== undefined && (typeof peerUserId !== "string" || !peerUserId)) ||
    (requestId !== undefined && (typeof requestId !== "string" || !requestId))
  )
    throw new Error("invalid conversation event");
  return {
    type,
    conversationId,
    messageId,
    sequence,
    ...(workspaceId ? { workspaceId } : {}),
    ...(threadRootId ? { threadRootId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(peerUserId ? { peerUserId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * An in-page notification signal (Frank, 2026-09-23): while a CoForge tab is open, the page shows
 * the OS notification itself from this realtime event instead of relying on Web Push, since Google
 * push services are unreachable from mainland-China staging and clients. It carries
 * no message text — the bodiless-event rule applies here too — so the browser
 * fetches title/body/url over authenticated HTTPS (`getMessageNotification`) before it can show
 * anything. Published only to the recipient's own `chat:user:<user_id>` channel.
 */
export type NotificationAvailableEvent = {
  type: "notification.available.v1";
  messageId: string;
  workspaceId: string;
};

export function decodeNotificationAvailableEvent(value: unknown): NotificationAvailableEvent {
  if (value instanceof Uint8Array)
    return decodeNotificationAvailableEvent(JSON.parse(utf8Decoder.decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const messageId = Reflect.get(value, "messageId");
  const workspaceId = Reflect.get(value, "workspaceId");
  if (
    type !== "notification.available.v1" ||
    typeof messageId !== "string" ||
    !messageId ||
    typeof workspaceId !== "string" ||
    !workspaceId
  )
    throw new Error("invalid conversation event");
  return { type, messageId, workspaceId };
}

/**
 * A membership-change signal for one conversation (join, leave, add, remove): a push in the
 * IM style, telling an open conversation its member directory is stale. It carries no member
 * payload — the client refetches the directory it already knows how to load — and only goes
 * to the conversation's own channel: the sidebar does not render the composer's candidates.
 */
export type MemberChangedEvent = {
  type: "member.changed.v1";
  conversationId: string;
  workspaceId?: string;
};

export function decodeMemberChangedEvent(value: unknown): MemberChangedEvent {
  if (value instanceof Uint8Array)
    return decodeMemberChangedEvent(JSON.parse(utf8Decoder.decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const conversationId = Reflect.get(value, "conversationId");
  const workspaceId = Reflect.get(value, "workspaceId");
  if (
    type !== "member.changed.v1" ||
    typeof conversationId !== "string" ||
    !conversationId ||
    (workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId))
  )
    throw new Error("invalid conversation event");
  return { type, conversationId, ...(workspaceId ? { workspaceId } : {}) };
}

/**
 * Something reached one person's Activity inbox without a message arriving in a conversation they
 * are in: a mention from outside the channel they were notified of. Published on that person's own
 * channel; their Activity page and nav dot re-read what they show.
 */
export type ActivityChangedEvent = { type: "activity.changed.v1"; workspaceId: string };

export function decodeActivityChangedEvent(value: unknown): ActivityChangedEvent {
  if (value instanceof Uint8Array)
    return decodeActivityChangedEvent(JSON.parse(utf8Decoder.decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const workspaceId = Reflect.get(value, "workspaceId");
  if (type !== "activity.changed.v1" || typeof workspaceId !== "string" || !workspaceId)
    throw new Error("invalid conversation event");
  return { type, workspaceId };
}

/**
 * A channel's own facts changed: its name, description, or archived state. Published on the
 * Workspace channel, so every member's sidebar re-reads its channel list, and on the channel's own
 * conversation channel, so a page showing it refetches its header and composer state. Like the
 * other signals it carries no payload beyond the ids; the client reloads what it shows.
 */
export type ChannelUpdatedEvent = {
  type: "channel.updated.v1";
  conversationId: string;
  workspaceId: string;
};

export function decodeChannelUpdatedEvent(value: unknown): ChannelUpdatedEvent {
  if (value instanceof Uint8Array)
    return decodeChannelUpdatedEvent(JSON.parse(utf8Decoder.decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const conversationId = Reflect.get(value, "conversationId");
  const workspaceId = Reflect.get(value, "workspaceId");
  if (
    type !== "channel.updated.v1" ||
    typeof conversationId !== "string" ||
    !conversationId ||
    typeof workspaceId !== "string" ||
    !workspaceId
  )
    throw new Error("invalid conversation event");
  return { type, conversationId, workspaceId };
}

/**
 * Something about the viewer's own place in a channel changed, wherever they changed it (this tab,
 * another tab, another device) or whoever changed it for them (added to or removed from a
 * channel). Published only on the viewer's own `chat:user:<user_id>` channel, the way Slack sends
 * `channel_marked`, `channel_joined`, `channel_left` and `pref_change` to every connection of one
 * user. Like the other signals it names ids only, except that `channel.marked.v1` carries the
 * channel's unread count after the move, as Slack's `channel_marked` does, so a read in the open
 * channel updates the sidebar without a list re-read per message.
 *
 * - `channel.marked.v1`: the read cursor moved (read, marked unread, marked Done).
 * - `channel.joined.v1` / `channel.left.v1`: the viewer joined, was added, created, left or was removed.
 * - `channel.closed.v1` / `channel.opened.v1`: the viewer closed the chat in their list, or brought it back.
 * - `pref.changed.v1`: the viewer's `muted` state of a channel, or their `pins` (pin, unpin, order).
 */
export type ViewerEvent =
  | {
      type: "channel.marked.v1";
      workspaceId: string;
      conversationId: string;
      unreadCount: number;
    }
  | {
      type: "channel.joined.v1" | "channel.left.v1" | "channel.closed.v1" | "channel.opened.v1";
      workspaceId: string;
      conversationId: string;
    }
  | { type: "pref.changed.v1"; workspaceId: string; name: "muted" | "pins" };

const CHANNEL_VIEWER_EVENT_TYPES = new Set([
  "channel.joined.v1",
  "channel.left.v1",
  "channel.closed.v1",
  "channel.opened.v1",
] as const);

export function decodeViewerEvent(value: unknown): ViewerEvent {
  if (value instanceof Uint8Array)
    return decodeViewerEvent(JSON.parse(utf8Decoder.decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const workspaceId = Reflect.get(value, "workspaceId");
  if (typeof workspaceId !== "string" || !workspaceId)
    throw new Error("invalid conversation event");
  if (type === "pref.changed.v1") {
    const name = Reflect.get(value, "name");
    if (name !== "muted" && name !== "pins") throw new Error("invalid conversation event");
    return { type, workspaceId, name };
  }
  const conversationId = Reflect.get(value, "conversationId");
  if (typeof conversationId !== "string" || !conversationId)
    throw new Error("invalid conversation event");
  if (type === "channel.marked.v1") {
    const unreadCount = Reflect.get(value, "unreadCount");
    if (!Number.isSafeInteger(unreadCount) || (unreadCount as number) < 0)
      throw new Error("invalid conversation event");
    return { type, workspaceId, conversationId, unreadCount: unreadCount as number };
  }
  if (!CHANNEL_VIEWER_EVENT_TYPES.has(type as never)) throw new Error("invalid conversation event");
  return {
    type: type as
      | "channel.joined.v1"
      | "channel.left.v1"
      | "channel.closed.v1"
      | "channel.opened.v1",
    workspaceId,
    conversationId,
  };
}
