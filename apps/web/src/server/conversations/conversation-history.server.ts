import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

const browserMessageFields = {
  id: true,
  sequence: true,
  threadRootId: true,
  senderMemberId: true,
  body: true,
  createdAt: true,
  attachment: {
    select: { id: true, fileName: true, contentType: true, sizeBytes: true },
  },
  sender: {
    select: {
      userId: true,
      user: { select: { username: true } },
      agent: { select: { name: true, displayName: true } },
    },
  },
} satisfies Prisma.MessageSelect;

const browserRootMessageFields = {
  ...browserMessageFields,
  replies: {
    orderBy: { sequence: "asc" as const },
    select: browserMessageFields,
  },
} satisfies Prisma.MessageSelect;

type BrowserMessageRow = Prisma.MessageGetPayload<{
  select: typeof browserMessageFields;
}>;

function mapBrowserMessage(message: BrowserMessageRow) {
  return {
    id: message.id,
    sequence: message.sequence,
    threadRootId: message.threadRootId ?? undefined,
    senderMemberId: message.senderMemberId,
    senderKind: message.sender.userId ? ("user" as const) : ("agent" as const),
    senderName: message.sender.userId
      ? `@${message.sender.user?.username}`
      : message.sender.agent?.displayName || message.sender.agent?.name || "Agent",
    body: message.body,
    createdAt: message.createdAt,
    attachment: message.attachment ?? undefined,
  };
}

/** Bounded browser history reads shared by direct conversations and public channels. */
export class ConversationHistory {
  constructor(private readonly db: PrismaClient) {}

  private async authorize(workspaceId: string, userId: string, conversationId: string) {
    const [membership, conversation] = await Promise.all([
      this.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { userId: true },
      }),
      this.db.conversation.findFirst({
        where: { id: conversationId, workspaceId },
        select: {
          directKey: true,
          channelName: true,
          members: { where: { userId }, select: { id: true } },
        },
      }),
    ]);
    if (!membership) throw new AppError("ACCESS_DENIED");
    if (!conversation) throw new AppError("NOT_FOUND");
    if (conversation.channelName !== null) return;
    if (conversation.directKey !== null && conversation.members.length > 0) return;
    throw new AppError("ACCESS_DENIED");
  }

  async listOwnMessages(
    workspaceId: string,
    userId: string,
    conversationId: string,
    page: { beforeSequence?: number; limit?: number } = {},
  ) {
    await this.authorize(workspaceId, userId, conversationId);
    const limit = Math.min(Math.max(page.limit ?? 20, 1), 50);
    const rows = await this.db.message.findMany({
      where: {
        conversationId,
        threadRootId: null,
        sequence: page.beforeSequence ? { lt: page.beforeSequence } : undefined,
        sender: { userId },
      },
      orderBy: { sequence: "desc" },
      take: limit + 1,
      select: {
        id: true,
        sequence: true,
        body: true,
        createdAt: true,
        attachment: { select: { fileName: true } },
      },
    });
    return {
      hasOlder: rows.length > limit,
      messages: rows
        .slice(0, limit)
        .reverse()
        .map((message) => ({
          id: message.id,
          sequence: message.sequence,
          body: message.body,
          createdAt: message.createdAt,
          attachmentFileName: message.attachment?.fileName,
        })),
    };
  }

  async loadAround(
    workspaceId: string,
    userId: string,
    conversationId: string,
    messageId: string,
    requestedLimit = 41,
  ) {
    await this.authorize(workspaceId, userId, conversationId);
    const anchor = await this.db.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        threadRootId: null,
        sender: { userId },
      },
      select: { sequence: true },
    });
    if (!anchor) throw new AppError("NOT_FOUND");

    const limit = Math.min(Math.max(requestedLimit, 1), 81);
    const beforeCount = Math.floor((limit - 1) / 2);
    const afterCount = limit - beforeCount - 1;
    const [beforeRows, afterRows] = await Promise.all([
      this.db.message.findMany({
        where: {
          conversationId,
          threadRootId: null,
          sequence: { lte: anchor.sequence },
        },
        orderBy: { sequence: "desc" },
        take: beforeCount + 2,
        select: browserRootMessageFields,
      }),
      this.db.message.findMany({
        where: {
          conversationId,
          threadRootId: null,
          sequence: { gt: anchor.sequence },
        },
        orderBy: { sequence: "asc" },
        take: afterCount + 1,
        select: browserRootMessageFields,
      }),
    ]);
    const messages = [
      ...beforeRows.slice(0, beforeCount + 1).reverse(),
      ...afterRows.slice(0, afterCount),
    ]
      .flatMap((message) => [message, ...message.replies])
      .sort((left, right) => left.sequence - right.sequence);
    return {
      conversationId,
      hasOlder: beforeRows.length > beforeCount + 1,
      hasNewer: afterRows.length > afterCount,
      messages: messages.map(mapBrowserMessage),
    };
  }
}
