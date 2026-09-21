import type { PrismaClient } from "../../../generated/client";
import {
  conversationRealtimeChannel,
  userConversationChannel,
  workspaceConversationChannel,
  type MessageAvailableEvent,
  type MemberChangedEvent,
} from "../../features/conversations/conversation-realtime";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";

export type ConversationRealtimeMessage = {
  conversationId: string;
  messageId: string;
  sequence: number;
  /** The message's Workspace; scopes the workspace-level signal fan-out. */
  workspaceId?: string;
  /** Present only for a thread reply (channel unread never counts thread replies). */
  threadRootId?: string;
  /** The viewing user of a direct message; routes the event to that user's own signal channel. */
  userId?: string;
  /** Present only for a direct message: the Agent badge this event bumps. */
  agentId?: string;
};

/**
 * The realtime fan-out scope for one conversation's messages (ADR 0046). A channel message goes
 * to the Workspace signal channel; a direct message goes only to its human viewer's own channel,
 * naming the Agent badge it belongs to, so DM metadata never reaches the Workspace. A direct
 * conversation that does not have exactly one human and one Agent (unreachable through the
 * supported create path) falls back to the Workspace channel rather than silently publishing
 * nowhere.
 */
export type MessageSignalScope = { workspaceId?: string; userId?: string; agentId?: string };

export async function messageSignalScope(
  db: PrismaClient,
  conversationId: string,
  workspaceId: string,
): Promise<MessageSignalScope> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      channelName: true,
      members: { select: { userId: true, agentId: true } },
    },
  });
  if (!conversation || conversation.channelName !== null) return { workspaceId };
  const userId = conversation.members.find((member) => member.userId)?.userId;
  const agentId = conversation.members.find((member) => member.agentId)?.agentId;
  return userId && agentId ? { userId, agentId } : { workspaceId };
}

export type ConversationRealtime = {
  messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }): Promise<void>;
  /** A push telling open conversations their member directory is stale (join/leave/add/remove). */
  memberChanged(input: { conversationId: string; workspaceId: string }): Promise<void>;
};

export class CentrifugoConversationRealtime implements ConversationRealtime {
  constructor(private readonly centrifugo: CentrifugoServerApi) {}

  async memberChanged(input: { conversationId: string; workspaceId: string }) {
    const event: MemberChangedEvent = {
      type: "member.changed.v1",
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
    };
    await this.centrifugo.publishJson(
      conversationRealtimeChannel(input.conversationId),
      event,
      crypto.randomUUID(),
    );
  }

  async messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }) {
    const { publicationId, ...message } = input;
    const event: MessageAvailableEvent = {
      type: "message.available.v1",
      ...message,
    };
    const idempotencyKey = publicationId ?? input.messageId;
    // The per-conversation channel drives the open conversation's reconciliation. The workspace
    // channel drives the sidebar's unread counts for every channel; a direct message instead
    // goes to its viewer's own channel, so DM metadata never reaches the whole Workspace and the
    // event can name the Agent badge directly.
    const fanOutChannel = input.userId
      ? input.agentId
        ? userConversationChannel(input.userId)
        : undefined
      : input.workspaceId
        ? workspaceConversationChannel(input.workspaceId)
        : undefined;
    await Promise.all([
      this.centrifugo.publishJson(
        conversationRealtimeChannel(input.conversationId),
        event,
        idempotencyKey,
      ),
      fanOutChannel
        ? this.centrifugo.publishJson(fanOutChannel, event, idempotencyKey)
        : Promise.resolve(),
    ]);
  }
}
