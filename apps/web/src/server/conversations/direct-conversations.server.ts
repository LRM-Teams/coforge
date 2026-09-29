import { MentionDeliveryIssuer } from "./mention-deliveries.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE, assertAgentLive } from "#src/server/agents/active-agent.server";
import { agentDirectKey, peopleDirectPeerId } from "#src/features/conversations/direct-key";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  PrismaDirectConversationRepository,
  type HistoryWindow,
} from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaDirectConversationPreferences } from "#src/server/db/repositories/direct-conversation-preferences.repositories.server";
import { announceViewerEvent, type ConversationRealtime } from "./conversation-realtime.server";
import { SendDirectMessage } from "./direct-message.server";
import { humanUnreadCount } from "./human-unread.server";
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
 * one with an Agent or a member, deciding who may use a conversation id and who it is with,
 * everything the page does there, and the viewer's Direct messages list (which DMs, with whom,
 * unread, pinned, closed). A DM with an Agent and one between members share every operation; only
 * a send goes its own way, since only an Agent is delivered to.
 */
export class DirectConversations {
  private readonly conversations: PrismaDirectConversationRepository;
  private readonly preferences: PrismaDirectConversationPreferences;

  constructor(
    private readonly db: PrismaClient,
    private readonly realtime?: Pick<ConversationRealtime, "viewerChanged">,
  ) {
    this.conversations = new PrismaDirectConversationRepository(db);
    this.preferences = new PrismaDirectConversationPreferences(db);
  }

  /** The viewer's conversation with their own Agent or a member, started on first open. */
  async open(
    workspaceId: string,
    viewerId: string,
    peer: { agentId: string } | { userId: string },
  ): Promise<{ conversationId: string }> {
    const { conversationId, created } = await this.openOrStart(workspaceId, viewerId, peer);
    // A DM that did not exist before shows up in every list it belongs to (Slack's `im_created`).
    // Everyone in it: both people, one for a member's DM with themself, the viewer with an Agent.
    const members = new Set([viewerId, "userId" in peer ? peer.userId : viewerId]);
    if (created)
      await announceViewerEvent(this.realtime, {
        userIds: [...members],
        event: { type: "dm.created.v1", workspaceId, conversationId },
      });
    return { conversationId };
  }

  private async openOrStart(
    workspaceId: string,
    viewerId: string,
    peer: { agentId: string } | { userId: string },
  ) {
    if ("userId" in peer)
      return openPeopleDirectConversation(this.db, workspaceId, viewerId, peer.userId);
    // A DM with an Agent is its creator's alone, and never starts with a deleted one.
    const own = await this.db.agent.findFirst({
      where: { id: peer.agentId, workspaceId, ownerId: viewerId, ...ACTIVE_AGENT_WHERE },
      select: { id: true },
    });
    if (!own) throw new AppError("ACCESS_DENIED");
    const conversation = await this.conversations.openUserAgent(
      workspaceId,
      viewerId,
      peer.agentId,
    );
    return { conversationId: conversation.id, created: conversation.created };
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
        members: { some: { userId: viewerId, leftAt: null } },
      },
      select: {
        directKey: true,
        members: {
          where: { OR: [{ agentId: { not: null } }, { userId: viewerId, leftAt: null }] },
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
    const peerUserId = peopleDirectPeerId(conversation.directKey, viewerId);
    if (peerUserId) {
      return {
        target: { kind: "people", peerUserId },
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

  /** The viewer's DMs as their Direct messages list shows them: each one and who it is with, the
   * pinned ones in order, and the closed ones. */
  list(workspaceId: string, viewerId: string) {
    return this.preferences.preferencesForUser(workspaceId, viewerId);
  }

  /** Unread per DM of the viewer's, by conversation id, for the list's badges. */
  unreadCounts(workspaceId: string, viewerId: string) {
    return this.preferences.unreadCountsForUser(workspaceId, viewerId);
  }

  /** Pins the DM after the viewer's other pins, or unpins it. Pins are one order across the
   * viewer's channels and DMs, so a change tells their other pages `pref.changed.v1` (`pins`). */
  async setPinned(workspaceId: string, viewerId: string, conversationId: string, pinned: boolean) {
    const memberId = await this.viewerMember(workspaceId, viewerId, conversationId);
    const { changed } = await this.preferences.setPinned(
      workspaceId,
      viewerId,
      { conversationId, memberId },
      pinned,
    );
    if (changed)
      await announceViewerEvent(this.realtime, {
        userIds: [viewerId],
        event: { type: "pref.changed.v1", workspaceId, name: "pins" },
      });
    return { pinned };
  }

  /** Marks the DM unread from the newest top-level message someone else sent, or clears the
   * marker. */
  async setUnread(workspaceId: string, viewerId: string, conversationId: string, unread: boolean) {
    const memberId = await this.viewerMember(workspaceId, viewerId, conversationId);
    const { changed, ...result } = await this.preferences.setUnread(
      { conversationId, memberId },
      unread,
    );
    if (changed)
      await announceViewerEvent(this.realtime, {
        userIds: [viewerId],
        event: {
          type: "dm.marked.v1",
          workspaceId,
          conversationId,
          unreadCount: await humanUnreadCount(this.db, conversationId, viewerId),
        },
      });
    return result;
  }

  /** Closes the DM in the viewer's list only, or brings it back; someone else's next top-level
   * message brings it back too. */
  async setHidden(workspaceId: string, viewerId: string, conversationId: string, hidden: boolean) {
    const memberId = await this.viewerMember(workspaceId, viewerId, conversationId);
    const { changed, ...result } = await this.preferences.setHidden(
      { conversationId, memberId },
      hidden,
    );
    if (changed)
      await announceViewerEvent(this.realtime, {
        userIds: [viewerId],
        event: { type: hidden ? "dm.closed.v1" : "dm.opened.v1", workspaceId, conversationId },
      });
    return result;
  }

  /** The viewer's own member row in a DM they may use; a list preference never needs more. */
  private async viewerMember(workspaceId: string, viewerId: string, conversationId: string) {
    return (await this.access(workspaceId, viewerId, conversationId, {})).viewerMemberId;
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

  /** What arrived after `afterSequence`, and of the replies only those after `afterReplySequence`
   * when it is given. */
  async updates(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    afterSequence: number,
    afterReplySequence?: number,
  ) {
    await this.authorize(workspaceId, viewerId, conversationId);
    return this.conversations.updatesSince(
      workspaceId,
      conversationId,
      afterSequence,
      afterReplySequence,
    );
  }

  /** Advances the viewer's read cursor; monotone and clamped. */
  async markRead(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
    throughSequence: number,
  ) {
    await this.authorize(workspaceId, viewerId, conversationId);
    // Like a channel read: a move tells the reader's other pages the badge it leaves (Slack's
    // `im_marked`); a read that moved nothing says nothing.
    const unreadCount = await this.conversations.markReadForUser(
      viewerId,
      conversationId,
      throughSequence,
    );
    if (unreadCount !== undefined)
      await announceViewerEvent(this.realtime, {
        userIds: [viewerId],
        event: { type: "dm.marked.v1", workspaceId, conversationId, unreadCount },
      });
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
            undefined,
            new MentionDeliveryIssuer(new PrismaMentionDeliveryRepository(this.db)),
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
