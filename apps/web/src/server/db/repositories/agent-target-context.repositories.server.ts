import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  MESSAGE_MENTIONS_SELECT,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import {
  agentAttentionDeliveryWhere,
  agentAttentionMessageWhere,
  readsAgentDeliveries,
  type AgentAttentionScope,
} from "#src/server/db/repositories/agent-attention.repositories.server";
import type { ResolvedAgentTarget } from "./direct-conversation.repositories.server";

/**
 * The context window of one resolved Agent target that an Agent send is checked against: the
 * messages it still owes attention to above a boundary (read and counted from one scope) and the
 * target's recent messages for a first touch. Reads only; resolving the target and advancing the
 * Agent's read position belong to `PrismaDirectConversationRepository`.
 */
export class PrismaAgentTargetContext {
  constructor(private readonly db: PrismaClient) {}

  async readPending(agentId: string, resolved: ResolvedAgentTarget, afterSequence?: number) {
    const { canonicalTarget, scope } = await this.pendingScope(agentId, resolved, afterSequence);
    const rows = await this.newestAttention(scope, 3);
    return rows.reverse().map((m) => agentContextRecord(m, canonicalTarget));
  }

  /** Count of the same scope `readPending` reads, unbounded by its 3-row window. */
  async countPending(agentId: string, resolved: ResolvedAgentTarget, afterSequence?: number) {
    const { scope } = await this.pendingScope(agentId, resolved, afterSequence);
    return readsAgentDeliveries(scope)
      ? this.db.agentMessageDelivery.count({ where: agentAttentionDeliveryWhere(scope) })
      : this.db.message.count({ where: agentAttentionMessageWhere(scope) });
  }

  /**
   * The target's most recent messages, ignoring the Agent's own read boundary or own messages: the
   * source of Raft's first-touch `syncing_hold` (`target_first_touch_recent_context`). Own messages
   * are not context to review, so they are excluded.
   */
  async readRecent(
    agentId: string,
    { conversationId, threadRootId, canonicalTarget, isChannel }: ResolvedAgentTarget,
    limit: number,
  ) {
    const agentMember = await this.db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true },
    });
    const rows = await this.newestAttention(
      { agentId, conversationId, threadRootId, isChannel, excludeSenderMemberId: agentMember?.id },
      limit,
    );
    return rows.reverse().map((m) => agentContextRecord(m, canonicalTarget));
  }

  /**
   * The pending-agent-context scope of a resolved target (conversation/thread and unread boundary)
   * shared by the pending read and its count, so a bounded read and its unbounded count cannot
   * drift apart.
   */
  private async pendingScope(
    agentId: string,
    { conversationId, threadRootId, canonicalTarget, isChannel }: ResolvedAgentTarget,
    afterSequence?: number,
  ) {
    const agentMember = await this.db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true },
    });
    const latestAgentMessage =
      afterSequence === undefined && agentMember
        ? await this.db.message.findFirst({
            where: {
              conversationId,
              threadRootId,
              senderMemberId: agentMember.id,
            },
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          })
        : undefined;
    return {
      canonicalTarget,
      scope: {
        agentId,
        conversationId,
        threadRootId,
        isChannel,
        afterSequence: afterSequence ?? latestAgentMessage?.sequence ?? 0,
      } satisfies AgentAttentionScope,
    };
  }

  /**
   * The `take` newest messages of one target that the Agent owes attention to, newest first. A
   * channel message counts only with the Agent's delivery row, so a channel's top level reads the
   * Agent's deliveries in that conversation (`agentId, conversationId, sequence` index) instead of
   * walking the channel's history and probing every message for a delivery. A thread (channel or
   * direct) and a direct message keep the message-side rule, whose range is the thread or
   * conversation itself: the delivery index cannot narrow to one thread, so a thread read there
   * would walk every delivery the Agent has in the channel.
   */
  private async newestAttention(scope: AgentAttentionScope, take: number) {
    const include = {
      sender: MESSAGE_SENDER_SELECT,
      attachments: { orderBy: { position: "asc" } },
      mentions: MESSAGE_MENTIONS_SELECT,
    } satisfies Prisma.MessageInclude;
    if (!readsAgentDeliveries(scope))
      return this.db.message.findMany({
        where: agentAttentionMessageWhere(scope),
        orderBy: { sequence: "desc" },
        take,
        include,
      });
    const delivered = await this.db.agentMessageDelivery.findMany({
      where: agentAttentionDeliveryWhere(scope),
      orderBy: { sequence: "desc" },
      take,
      select: { messageId: true },
    });
    if (!delivered.length) return [];
    return this.db.message.findMany({
      where: { id: { in: delivered.map((row) => row.messageId) } },
      orderBy: { sequence: "desc" },
      include,
    });
  }
}

/** One row of the Agent-facing context window, shared by the pending and recent readers so both
 * surfaces cannot drift apart. */
function agentContextRecord<
  Row extends {
    id: string;
    sequence: number;
    sender: Parameters<typeof agentMessageSender>[0];
    body: string;
    mentions: readonly MessageMentionRef[];
    createdAt: Date;
    attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[];
  },
>(m: Row, canonicalTarget: string) {
  const sender = agentMessageSender(m.sender);
  return {
    id: m.id,
    sequence: m.sequence,
    senderKind: sender.kind,
    senderHandle: sender.handle,
    senderDescription: sender.description,
    ...agentMessageView(m),
    createdAt: m.createdAt,
    target: canonicalTarget,
    attachments: m.attachments,
  };
}
