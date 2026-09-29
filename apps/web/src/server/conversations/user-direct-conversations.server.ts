import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  isPeopleDirectKey,
  peopleDirectKey,
  peopleDirectKeyPair,
} from "#src/features/conversations/direct-key";
import { attachmentView } from "#src/server/attachments/attachment-view.server";
import {
  attachToMessage,
  claimUploadedAttachments,
} from "#src/server/attachments/message-attachments.server";
import { allocateSequence } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { storeMessageBody } from "./message-references.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";

type UserDirectMessageInput = {
  workspaceId: string;
  conversationId: string;
  senderUserId: string;
  body: string;
  attachmentIds?: readonly string[];
  threadRootId?: string;
};

/** Opens the viewer's direct conversation with `peerUserId`, starting it on first open. */
export async function openPeopleDirectConversation(
  db: PrismaClient,
  workspaceId: string,
  viewerId: string,
  peerUserId: string,
) {
  // One member row each; a member's conversation with themself has one.
  const userIds = [...new Set([viewerId, peerUserId])];
  const directKey = peopleDirectKey(viewerId, peerUserId);
  const members = await db.workspaceMembership.count({
    where: { workspaceId, userId: { in: userIds } },
  });
  if (members !== userIds.length) throw new AppError("ACCESS_DENIED");
  const where = { workspaceId_directKey: { workspaceId, directKey } };
  const existing = await db.conversation.findUnique({ where, select: { id: true } });
  if (existing) {
    // A member's row can be missing altogether; opening the conversation again restores it.
    await db.conversationMember.createMany({
      data: userIds.map((userId) => ({ conversationId: existing.id, workspaceId, userId })),
      skipDuplicates: true,
    });
    return { conversationId: existing.id };
  }
  try {
    const created = await db.conversation.create({
      data: {
        workspace: { connect: { id: workspaceId } },
        directKey,
        members: {
          create: userIds.map((userId) => ({
            workspace: { connect: { id: workspaceId } },
            user: { connect: { id: userId } },
          })),
        },
      },
      select: { id: true },
    });
    return { conversationId: created.id };
  } catch (error) {
    // A concurrent first open won the insert; reuse its conversation.
    if (!isUniqueViolation(error)) throw error;
    const raced = await db.conversation.findUniqueOrThrow({ where, select: { id: true } });
    return { conversationId: raced.id };
  }
}

/**
 * A direct conversation between Workspace members: one per pair, whoever opens it, and one a
 * member keeps with themself. No Agent is ever a member, so nothing in it is delivered to one.
 * Its key is `peopleDirectKey`.
 */
export class UserDirectConversations {
  constructor(
    private readonly db: PrismaClient,
    private readonly idempotency: MessageRequestIdempotency,
    private readonly realtime?: Pick<ConversationRealtime, "messageAvailable">,
  ) {}

  /** Opens the viewer's direct conversation with `peerUserId`, starting it on first open. */
  open(workspaceId: string, viewerId: string, peerUserId: string) {
    return openPeopleDirectConversation(this.db, workspaceId, viewerId, peerUserId);
  }

  /**
   * Stores a member's message once per `requestId`, then tells the conversation's open pages and
   * the other member's list. Nothing is
   * delivered to an Agent, and `@handle` stays plain text: a direct conversation between people
   * has no one else to mention.
   */
  async send(input: UserDirectMessageInput & { requestId: string }) {
    const { workspaceId, conversationId, senderUserId } = input;
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      // Someone who left the Workspace neither sends here nor hears of new messages.
      select: {
        directKey: true,
        members: { where: ACTIVE_MEMBER_WHERE, select: { id: true, userId: true } },
      },
    });
    const members = conversation?.members ?? [];
    const sender = members.find((member) => member.userId === senderUserId);
    if (!sender || !conversation?.directKey || !isPeopleDirectKey(conversation.directKey))
      throw new AppError("ACCESS_DENIED");
    const message = await this.idempotency.execute(
      { workspaceId, senderKind: "user", senderId: senderUserId, requestId: input.requestId },
      () => this.store(input, sender.id),
    );
    try {
      await this.realtime?.messageAvailable({
        conversationId,
        messageId: message.id,
        sequence: message.sequence,
        // The other member's list only: the sender's own message never bumps their badge.
        directUserIds: members.flatMap((member) =>
          member.userId && member.userId !== senderUserId ? [member.userId] : [],
        ),
        directPair: peopleDirectKeyPair(conversation.directKey),
        requestId: input.requestId,
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
      });
    } catch {
      // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
    }
    return message;
  }

  private async store(input: UserDirectMessageInput, senderMemberId: string) {
    const { workspaceId, conversationId, senderUserId } = input;
    if (input.threadRootId) {
      const root = await this.db.message.findFirst({
        where: { id: input.threadRootId, conversationId, threadRootId: null },
        select: { id: true },
      });
      if (!root) throw new AppError("INVALID_INPUT");
    }
    return this.db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      const attachments = await claimUploadedAttachments(
        tx,
        { workspaceId, conversationId, uploaderId: senderUserId },
        input.attachmentIds ?? [],
      );
      const stored = await storeMessageBody(tx, { workspaceId, conversationId }, input.body, {
        targets: [],
      });
      const message = await tx.message.create({
        data: {
          conversationId,
          workspaceId,
          senderMemberId,
          threadRootId: input.threadRootId,
          body: stored.body,
          sequence,
        },
        select: { id: true, body: true, createdAt: true, sequence: true, threadRootId: true },
      });
      await attachToMessage(tx, message.id, attachments);
      return {
        ...message,
        workspaceId,
        attachments: attachments.map((attachment) => attachmentView(attachment)),
      };
    });
  }
}
