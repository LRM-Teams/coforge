import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import {
  lockMemberPins,
  setConversationPin,
} from "#src/server/conversations/conversation-pins.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { PrismaDirectConversationRepository } from "./direct-conversation.repositories.server";

/**
 * The viewer's own list preferences for their DMs: pinned, marked unread, and closed, plus the
 * sidebar's read of them. Only what the viewer's list shows changes here; the conversation and its
 * messages belong to `PrismaDirectConversationRepository`, which also finds the DM these apply to.
 */
export class PrismaDirectConversationPreferences {
  constructor(
    private readonly db: PrismaClient,
    private readonly conversations: Pick<
      PrismaDirectConversationRepository,
      "findUserAgentConversation"
    >,
  ) {}

  /**
   * The viewer's own membership of their DM with this Agent, resolved without creating anything:
   * a preference must not bring a conversation into existence as a side effect. `NOT_FOUND` covers
   * both "no DM yet" and "not this viewer's DM", so the mutations cannot probe another pair.
   */
  private async memberFor(workspaceId: string, userId: string, agentId: string) {
    const conversation = await this.conversations.findUserAgentConversation(
      workspaceId,
      userId,
      agentId,
    );
    if (!conversation) throw new AppError("NOT_FOUND");
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId: conversation.id, userId, leftAt: null },
      select: { id: true },
    });
    if (!member) throw new AppError("NOT_FOUND");
    return { conversationId: conversation.id, memberId: member.id };
  }

  /** Pins the viewer's DM with this Agent above the rest of their list, or unpins it (#121). The
   * conversation lock orders it against concurrent writes the way the channel side does. */
  async setPinnedForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    pinned: boolean,
    sortOrder?: number,
  ) {
    const { conversationId, memberId } = await this.memberFor(workspaceId, userId, agentId);
    await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, workspaceId, userId);
      await lockConversation(tx, conversationId);
      await setConversationPin(
        tx,
        { workspaceId, userId, conversationId, memberId },
        pinned,
        sortOrder,
      );
    });
    return { pinned };
  }

  /** Marks the viewer's DM with this Agent unread, anchored on its newest top-level message, or
   * clears the marker. A DM with no messages has nothing to mark. */
  async setUnreadForUser(workspaceId: string, userId: string, agentId: string, unread: boolean) {
    const { conversationId } = await this.memberFor(workspaceId, userId, agentId);
    let marker: number | null = null;
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      if (unread) {
        const newest = await tx.message.findFirst({
          where: { conversationId, threadRootId: null },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        marker = newest?.sequence ?? null;
      }
      await tx.conversationMember.updateMany({
        where: { conversationId, userId, leftAt: null },
        data: { unreadFromSequence: marker },
      });
    });
    return { unread: marker !== null };
  }

  /** Closes the viewer's DM with this Agent in their list only, or brings it back. */
  async setHiddenForUser(workspaceId: string, userId: string, agentId: string, hidden: boolean) {
    const { conversationId } = await this.memberFor(workspaceId, userId, agentId);
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      await tx.conversationMember.updateMany({
        where: { conversationId, userId, leftAt: null },
        data: { hiddenAt: hidden ? new Date() : null },
      });
    });
    return { hidden };
  }

  /**
   * What the sidebar needs about the viewer's own DMs, keyed the way it addresses them: an Agent id
   * (DM rows come from the live Agent list, not from a server list). Pins carry their order; hidden
   * DMs are listed so the sidebar can leave them out.
   */
  async preferencesForUser(workspaceId: string, userId: string) {
    const dmScope = {
      workspaceId,
      userId,
      leftAt: null,
      conversation: { directKey: { not: null } },
    };
    const [conversations, pins, hidden] = await Promise.all([
      // Which of the live Agent rows are conversations at all: DM rows come from the Agent list, so
      // this is the only way the sidebar can tell a started DM from an Agent it has never written
      // to — and a preference must not be offered on the latter (it would only answer NOT_FOUND).
      this.db.conversationMember.findMany({
        where: dmScope,
        select: {
          conversation: {
            select: { members: { where: { agentId: { not: null } }, select: { agentId: true } } },
          },
        },
      }),
      this.db.conversationPin.findMany({
        where: {
          workspaceId,
          member: { userId, leftAt: null },
          conversation: { directKey: { not: null } },
        },
        select: {
          sortOrder: true,
          conversation: {
            select: { members: { where: { agentId: { not: null } }, select: { agentId: true } } },
          },
        },
      }),
      // DMs the viewer closed that stay closed: a top-level message the Agent posted after the
      // close brings one back. `NOT EXISTS` stops at the first such message on the
      // `messages(conversationId, createdAt)` index instead of loading the DM's history.
      this.db.$queryRaw<{ agentId: string }[]>`
        SELECT am."agentId" AS "agentId"
        FROM "conversation_members" cm
        JOIN "conversations" c
          ON c."id" = cm."conversationId"
         AND c."workspaceId" = ${workspaceId}::uuid
         AND c."directKey" IS NOT NULL
        JOIN "conversation_members" am
          ON am."conversationId" = cm."conversationId"
         AND am."agentId" IS NOT NULL
        WHERE cm."userId" = ${userId}::uuid
          AND cm."workspaceId" = ${workspaceId}::uuid
          AND cm."leftAt" IS NULL
          AND cm."hiddenAt" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "messages" m
            WHERE m."conversationId" = cm."conversationId"
              AND m."threadRootId" IS NULL
              AND m."senderMemberId" = am."id"
              AND m."createdAt" > cm."hiddenAt"
          )
      `,
    ]);
    return {
      conversations: conversations.flatMap((row) =>
        row.conversation.members.map((member) => member.agentId!),
      ),
      pinned: pins
        .flatMap((pin) =>
          pin.conversation.members.map((m) => ({ agentId: m.agentId!, sortOrder: pin.sortOrder })),
        )
        .sort((left, right) => left.sortOrder - right.sortOrder),
      // Closed DMs, pinned or not: the sidebar keeps a pinned one listed (in Pinned).
      hidden: hidden.map((row) => row.agentId),
    };
  }
}
