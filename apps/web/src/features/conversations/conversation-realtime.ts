import { z } from "zod";
import { utf8Decoder } from "@lrm/coforge-sdk/internal";
export const conversationRealtimeChannel = (conversationId: string) => `chat:${conversationId}`;

/**
 * Workspace-level signal fan-out for conversation activity. Carries the same
 * versioned `message.available.v1` payloads as `chat:<conversationId>`, but
 * one subscription per open Workspace keeps the sidebar unread counts live
 * without holding a per-conversation subscription for every channel in the
 * list. It also carries `channel.created.v1` and `channel.updated.v1`, so the sidebar lists a
 * created, renamed, deleted or archived channel from the event, and `task.changed.v1` (`features/tasks/task-realtime.ts`), so an open
 * Tasks page updates the rows a Task write changed, and `workspace.deleted.v1`
 * (`features/workspaces/workspace-realtime.ts`), so every open page leaves a deleted Workspace. Authorization mirrors the status/activity workspace channels: the
 * subscription token is issued only to Workspace members.
 */
export const workspaceConversationChannel = (workspaceId: string) =>
  `chat:workspace:${workspaceId}`;

/**
 * The viewer's own direct-message signal channel. A DM event is published here (and on its
 * conversation channel) instead of the workspace channel, so direct-message metadata never
 * reaches every Workspace member; each publication names who is on the other side, which is how
 * the sidebar tells a DM's event from a channel's. It also carries the viewer's own
 * `ViewerEvent`s (their reads, joins, closes, mutes, pins and saves, wherever they made them).
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
   * (`idempotencyKey`). The sender's own page shows the message greyed the moment it is submitted and
   * uses this to replace that pending copy with the real message, even when this signal outruns
   * the send's own response. Meaningless to anyone else, who ignores it.
   */
  idempotencyKey?: string;
  /**
   * The person who wrote the message, as Slack's `message` event names its `user`; absent for an
   * Agent's or a system message, and from an older server. A person's own pages never count their
   * own message unread (the server's count never does), wherever they sent it from.
   */
  senderUserId?: string;
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
  const idempotencyKey = Reflect.get(value, "idempotencyKey");
  const senderUserId = Reflect.get(value, "senderUserId");
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
    (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey)) ||
    (senderUserId !== undefined && (typeof senderUserId !== "string" || !senderUserId))
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
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(senderUserId ? { senderUserId } : {}),
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
 * Something reached one person's Activity inbox that no badge signal announces: a mention from
 * outside the channel they were notified of, or a Task assignment receipt naming them (a notice,
 * which counts no badge). Published on that person's own channel; their Activity page and nav dot
 * re-read what they show.
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

const channelInfo = z.object({
  name: z.string().min(1),
  description: z.string(),
  archived: z.boolean(),
});

/**
 * A channel's name, description and archived state, as every member may see them. A channel
 * event carries it, as Slack's `channel_created` and `channel_rename` carry the channel, so a
 * sidebar updates its row from the event instead of re-reading its list.
 */
export type ChannelInfo = z.infer<typeof channelInfo>;

const channelUpdatedEvent = z.object({
  type: z.literal("channel.updated.v1"),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  /** The channel's info after the change. */
  channel: channelInfo.optional(),
  /** The channel was deleted, or hidden from the whole Workspace (`#general`). */
  gone: z.literal(true).optional(),
});

/**
 * A channel's own facts changed: its name, description or archived state, or it is gone. Published
 * on the Workspace channel, so every member's sidebar applies it, and on the channel's own
 * conversation channel, so a page showing it refetches its header and composer state. An event
 * with neither `channel` nor `gone` (from an older server) has the sidebar re-read its lists.
 */
export type ChannelUpdatedEvent = z.infer<typeof channelUpdatedEvent>;

export function decodeChannelUpdatedEvent(value: unknown): ChannelUpdatedEvent {
  const event = decodeJsonPublication(channelUpdatedEvent, value);
  if (!event) throw new Error("invalid conversation event");
  return event;
}

/**
 * Something about the viewer's own place in a channel or DM changed, wherever they changed it (this tab,
 * another tab, another device) or whoever changed it for them (added to or removed from a
 * channel). Published only on the viewer's own `chat:user:<user_id>` channel, the way Slack sends
 * `channel_marked`, `channel_joined`, `channel_left` and `pref_change` to every connection of one
 * user. Like the other signals it names ids only, except that `channel.marked.v1` carries the
 * channel's unread count and read cursor after the move (Slack's `channel_marked` carries the
 * cursor as its `ts`), so a read in the open channel updates the sidebar without a list re-read per
 * message, and a page's stored window of that channel opens with the divider where it now is.
 *
 * - `channel.marked.v1`: the read cursor moved (read, marked unread, marked Done).
 * - `channel.joined.v1` / `channel.left.v1`: the viewer joined, was added, created, left or was removed.
 * - `channel.closed.v1` / `channel.opened.v1`: the viewer closed the chat in their list, or brought it back.
 * - `pref.changed.v1`: the viewer's `muted` state of a channel, or their `pins` (pin, unpin, order).
 * - `dm.marked.v1`, `dm.opened.v1`, `dm.closed.v1`: the same for one of the viewer's DMs (Slack's
 *   `im_marked`, `im_open`, `im_close`); `dm.created.v1`: a DM with them was started (`im_created`).
 * - `saved.added.v1` / `saved.removed.v1`: the viewer saved or unsaved a message (Slack's
 *   `star_added` / `star_removed`).
 */
const viewerEventIds = { workspaceId: z.string().min(1), conversationId: z.string().min(1) };
const viewerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["channel.marked.v1", "dm.marked.v1"]),
    ...viewerEventIds,
    unreadCount: z.number().int().nonnegative(),
    // Where the read cursor stands after the move, as Slack's `channel_marked` carries its `ts`.
    readThroughSequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.enum([
      "channel.joined.v1",
      "channel.left.v1",
      "channel.closed.v1",
      "channel.opened.v1",
      "dm.created.v1",
      "dm.opened.v1",
      "dm.closed.v1",
    ]),
    ...viewerEventIds,
  }),
  z.object({
    type: z.enum(["saved.added.v1", "saved.removed.v1"]),
    ...viewerEventIds,
    messageId: z.string().min(1),
  }),
  z.object({
    type: z.literal("pref.changed.v1"),
    workspaceId: z.string().min(1),
    name: z.enum(["muted", "pins"]),
  }),
]);

export type ViewerEvent = z.infer<typeof viewerEvent>;

/** A publication's JSON (raw bytes or already parsed) read as `schema`, or undefined when it is
 * some other publication on the channel. */
function decodeJsonPublication<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  let data = value;
  if (value instanceof Uint8Array) {
    try {
      data = JSON.parse(utf8Decoder.decode(value)) as unknown;
    } catch {
      return undefined;
    }
  }
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** The event, or undefined for any other publication on the viewer's channel (most are messages). */
export function decodeViewerEvent(value: unknown): ViewerEvent | undefined {
  return decodeJsonPublication(viewerEvent, value);
}

const channelCreatedEvent = z.object({
  type: z.literal("channel.created.v1"),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  /** Absent only from an older server, which has the sidebar re-read its lists. */
  channel: channelInfo.optional(),
});

/**
 * A channel was created in the Workspace, by a person, an Agent or an action card (Slack's
 * `channel_created`). Published on the Workspace channel with the channel's info, so every
 * member's sidebar lists it from the event alone.
 */
export type ChannelCreatedEvent = z.infer<typeof channelCreatedEvent>;

/** The event, or undefined for any other publication on the Workspace channel. */
export function decodeChannelCreatedEvent(value: unknown): ChannelCreatedEvent | undefined {
  return decodeJsonPublication(channelCreatedEvent, value);
}
