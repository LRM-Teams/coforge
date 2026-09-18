export const conversationRealtimeChannel = (conversationId: string) => `chat:${conversationId}`;

/**
 * Workspace-level signal fan-out for conversation activity. Carries the same
 * versioned `message.available.v1` payloads as `chat:<conversationId>`, but
 * one subscription per open Workspace keeps the sidebar unread counts live
 * without holding a per-conversation subscription for every channel in the
 * list. Authorization mirrors the status/activity workspace channels: the
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
    (agentId !== undefined && (typeof agentId !== "string" || !agentId))
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
  };
}
