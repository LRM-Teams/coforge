import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE, assertAgentLive } from "#src/server/agents/active-agent.server";
import {
  agentDirectKey,
  isPeopleDirectKey,
  peopleDirectKeyPair,
} from "#src/features/conversations/direct-key";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  PrismaDirectConversationRepository,
  type HistoryWindow,
} from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { SendDirectMessage } from "./direct-message.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { toggleUserMessageReaction } from "./user-message-reactions.server";
import {
  openPeopleDirectConversation,
  UserDirectConversations,
} from "./user-direct-conversations.server";

/** Who is on the other side of a direct conversation, from the viewer's seat. */
export type DirectConversationTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "people"; peerUserId: string };

/** What a send needs besides the database: request idempotency and the transports it tells. */
export type DirectMessageSending = {
  idempotency: MessageRequestIdempotency;
  centrifugo: Pick<CentrifugoServerApi, "publish">;
  realtime?: ConversationRealtime;
};

/**
 * A viewer's direct conversations addressed by id, the way their pages are (`dm/<id>`): opening
 * one with an Agent or a member, deciding who may use a conversation id and who it is with, and
 * everything the page does there. A DM with an Agent and one between members share every
 * operation; only a send goes its own way, since only an Agent is delivered to.
 */
export class DirectConversations {
  private readonly conversations: PrismaDirectConversationRepository;

  constructor(private readonly db: PrismaClient) {
    this.conversations = new PrismaDirectConversationRepository(db);
  }

  /** The viewer's conversation with their own Agent or a member, started on first open. */
  async open(
    workspaceId: string,
    viewerId: string,
    peer: { agentId: string } | { userId: string },
  ): Promise<{ conversationId: string }> {
    if ("userId" in peer)
      return openPeopleDirectConversation(this.db, workspaceId, viewerId, peer.userId);
    // A DM with an Agent is its creator's alone, and never starts with a deleted one.
    const own = await this.db.agent.findFirst({
      where: { id: peer.agentId, workspaceId, ownerId: viewerId, ...ACTIVE_AGENT_WHERE },
      select: { id: true },
    });
    if (!own) throw new AppError("ACCESS_DENIED");
    const conversation = await this.conversations.getOrCreateUserAgent(
      workspaceId,
      viewerId,
      peer.agentId,
    );
    return { conversationId: conversation.id };
  }

  /**
   * Who a direct conversation of the viewer's is with, once the viewer may use it: a DM with an
   * Agent is its creator's alone, and one with a deleted Agent stays readable but takes no new
   * message (`canSend`). `NOT_FOUND` for anything that is not the viewer's direct conversation.
   */
  async authorize(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    options: { canSend?: boolean } = {},
  ): Promise<DirectConversationTarget> {
    return (await this.access(workspaceId, viewerId, conversationId, options)).target;
  }

  /** `authorize`, with the viewer's own member row in the conversation. */
  private async access(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    { canSend = false }: { canSend?: boolean },
  ): Promise<{ target: DirectConversationTarget; viewerMemberId: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: {
        id: conversationId,
        workspaceId,
        directKey: { not: null },
        members: { some: { userId: viewerId } },
      },
      select: {
        directKey: true,
        members: {
          where: { OR: [{ agentId: { not: null } }, { userId: viewerId }] },
          select: {
            id: true,
            userId: true,
            agent: { select: { id: true, ownerId: true, deletedAt: true } },
          },
        },
      },
    });
    const viewerMemberId = conversation?.members.find((member) => member.userId === viewerId)?.id;
    if (!conversation?.directKey || !viewerMemberId) throw new AppError("NOT_FOUND");
    if (isPeopleDirectKey(conversation.directKey)) {
      const [first, second] = peopleDirectKeyPair(conversation.directKey);
      return {
        target: { kind: "people", peerUserId: first === viewerId ? second : first },
        viewerMemberId,
      };
    }
    const agent = conversation.members.find((member) => member.agent)?.agent;
    if (!agent) throw new AppError("NOT_FOUND");
    // Only the creator's own DM with it: a member row in another member's DM grants nothing.
    if (agent.ownerId !== viewerId || conversation.directKey !== agentDirectKey(viewerId, agent.id))
      throw new AppError("ACCESS_DENIED");
    if (canSend) assertAgentLive(agent);
    return { target: { kind: "agent", agentId: agent.id }, viewerMemberId };
  }

  /** A window of the conversation's history and who is on the other side. */
  async page(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    window?: HistoryWindow,
  ) {
    await this.authorize(workspaceId, viewerId, conversationId);
    return this.conversations.openConversationForUser(
      workspaceId,
      viewerId,
      conversationId,
      window,
    );
  }

  /** What arrived after `afterSequence`. */
  async updates(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    afterSequence: number,
  ) {
    await this.authorize(workspaceId, viewerId, conversationId);
    return this.conversations.updatesSince(workspaceId, conversationId, afterSequence);
  }

  /** Advances the viewer's read cursor; monotone and clamped. */
  async markRead(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    throughSequence: number,
  ) {
    await this.authorize(workspaceId, viewerId, conversationId);
    await this.conversations.markReadForUser(viewerId, conversationId, throughSequence);
  }

  /** Advances the viewer's read position in one thread. */
  async markThreadRead(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    threadRootId: string,
    throughSequence: number,
  ) {
    await this.authorize(workspaceId, viewerId, conversationId);
    await this.conversations.markThreadReadForUser(
      workspaceId,
      viewerId,
      conversationId,
      threadRootId,
      throughSequence,
    );
  }

  /** The viewer's own emoji reaction on a message; returns the message's fresh summaries. */
  async react(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    reaction: { messageId: string; emoji: string; active: boolean },
  ) {
    await this.authorize(workspaceId, viewerId, conversationId);
    return toggleUserMessageReaction(this.db, {
      workspaceId,
      conversationId,
      userId: viewerId,
      ...reaction,
    });
  }

  /**
   * Stores the viewer's message once per `requestId` and tells both sides: an Agent is delivered
   * to, a member only sees it arrive.
   */
  async send(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    message: { requestId: string; body: string; attachmentIds?: string[]; threadRootId?: string },
    { idempotency, centrifugo, realtime }: DirectMessageSending,
  ) {
    const { target, viewerMemberId } = await this.access(workspaceId, viewerId, conversationId, {
      canSend: true,
    });
    const stored =
      target.kind === "people"
        ? await new UserDirectConversations(this.db, idempotency, realtime).send({
            workspaceId,
            conversationId,
            senderUserId: viewerId,
            ...message,
          })
        : await new SendDirectMessage(
            this.conversations,
            idempotency,
            centrifugo,
            realtime,
          ).execute({
            workspaceId,
            conversationId,
            senderMemberId: viewerMemberId,
            senderUserId: viewerId,
            ...message,
          });
    return { ...stored, senderMemberId: viewerMemberId };
  }
}
