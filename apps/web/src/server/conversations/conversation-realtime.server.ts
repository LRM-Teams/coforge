import type { PrismaClient } from "#src/generated/prisma/client";
import {
  conversationRealtimeChannel,
  userConversationChannel,
  workspaceConversationChannel,
  type MessageAvailableEvent,
  type MemberChangedEvent,
} from "#src/features/conversations/conversation-realtime";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";

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
  /** Present only for a person's send: its idempotency key, so the sender's page can match the
   * pending copy it shows to this message (see `MessageAvailableEvent.requestId`). */
  requestId?: string;
};

/**
 * The realtime fan-out scope for one conversation's messages. A channel message goes
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
  /** A push telling each named channel's open pages that its member list is stale. */
  memberChanged(input: { workspaceId: string; conversationIds: readonly string[] }): Promise<void>;
};

export class CentrifugoConversationRealtime implements ConversationRealtime {
  constructor(private readonly centrifugo: CentrifugoServerApi) {}

  async memberChanged(input: { workspaceId: string; conversationIds: readonly string[] }) {
    // One publication per channel: each event names its own conversation, which the page checks.
    await Promise.all(
      input.conversationIds.map((conversationId) => {
        const event: MemberChangedEvent = {
          type: "member.changed.v1",
          conversationId,
          workspaceId: input.workspaceId,
        };
        return this.centrifugo.publishJson(
          conversationRealtimeChannel(conversationId),
          event,
          crypto.randomUUID(),
        );
      }),
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

/**
 * Tells the open pages of these channels that their member list changed — the composer's @-list
 * and plain-@handle labels — once the membership write has committed. Every write that changes
 * who is in a channel calls this, the way Slack sends `member_joined_channel` and Discord sends
 * `GUILD_MEMBER_ADD`, so a page never polls or waits for a refresh.
 *
 * Best effort: the write already happened, and a page that misses the signal refetches when it
 * regains focus or resubscribes without recovering. Without an injected publisher it uses the
 * production Centrifugo one, so no write path can skip the signal by leaving it unwired.
 */
export async function announceMemberChanged(
  realtime: Pick<ConversationRealtime, "memberChanged"> | undefined,
  input: { workspaceId: string; conversationIds: readonly string[] },
): Promise<void> {
  if (input.conversationIds.length === 0) return;
  try {
    await (
      realtime ?? new CentrifugoConversationRealtime(createCentrifugoServerApi())
    ).memberChanged(input);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "conversation_realtime:member_changed_failed",
        workspace_id: input.workspaceId,
        conversation_count: input.conversationIds.length,
        error_type: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}
