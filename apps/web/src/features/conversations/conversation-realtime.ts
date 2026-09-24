export const conversationRealtimeChannel = (conversationId: string) => `chat:${conversationId}`;

/**
 * Workspace-level signal fan-out for conversation activity. Carries the same
 * versioned `message.available.v1` payloads as `chat:<conversationId>`, but
 * one subscription per open Workspace keeps the sidebar unread counts live
 * without holding a per-conversation subscription for every channel in the
 * list. It also carries `channel.updated.v1`, so the sidebar re-reads a renamed
 * or archived channel, and `task.changed.v1` (`features/tasks/task-realtime.ts`), so an open
 * Tasks page updates the rows a Task write changed. Authorization mirrors the status/activity workspace channels: the
 * subscription token is issued only to Workspace members.
 */
export const workspaceConversationChannel = (workspaceId: string) =>
  `chat:workspace:${workspaceId}`;

/**
 * The viewer's own direct-message signal channel. A DM event is published here (and on its
 * conversation channel) instead of the workspace channel, so direct-message metadata never
 * reaches every Workspace member, and the publication can name the Agent badge it belongs to
 * directly rather than making the browser reverse-map a conversation id.
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
  /**
   * Set only for a direct message: the Agent whose sidebar badge this event bumps. The user
   * channel is already scoped to one viewer, so the badge key needs no conversation alias.
   */
  agentId?: string;
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
    return decodeMessageAvailableEvent(JSON.parse(new TextDecoder().decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const conversationId = Reflect.get(value, "conversationId");
  const messageId = Reflect.get(value, "messageId");
  const sequence = Reflect.get(value, "sequence");
  const workspaceId = Reflect.get(value, "workspaceId");
  const threadRootId = Reflect.get(value, "threadRootId");
  const agentId = Reflect.get(value, "agentId");
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
    return decodeNotificationAvailableEvent(JSON.parse(new TextDecoder().decode(value)) as unknown);
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
    return decodeMemberChangedEvent(JSON.parse(new TextDecoder().decode(value)) as unknown);
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
    return decodeChannelUpdatedEvent(JSON.parse(new TextDecoder().decode(value)) as unknown);
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
