import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { attachmentView } from "#src/server/attachments/attachment-view.server";
import { BROWSER_MESSAGE_MENTIONS_SELECT, browserMessageMention } from "./mentions.server";
import { MESSAGE_REACTIONS_SELECT, reactionSummaries } from "./message-reactions.server";
import {
  browserSenderAvatarUrl,
  browserSenderHandle,
  browserSenderName,
} from "./sender-display.server";
import { attachmentFileNameSummary } from "#src/features/conversations/attachment-file-name";
import type { ActionCardView } from "./action-cards.server";
import {
  parseWeeklyReportAssistantSuggestion,
  weeklyReportAssistantSuggestionDisplayBody,
} from "#src/server/records/weekly-report-assistant-suggestion.server";
import { followedThreadRootIds, readWindowThreads } from "./thread-summaries.server";

/** Exported so projections that must render exactly like the message stream (the Saved list,
 * #120/#124) reuse this same row shape instead of growing a near-copy. */
export const browserMessageFields = {
  id: true,
  sequence: true,
  threadRootId: true,
  senderMemberId: true,
  body: true,
  createdAt: true,
  attachments: {
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, objectKey: true },
    orderBy: { position: "asc" as const },
  },
  sender: {
    select: {
      userId: true,
      agentId: true,
      user: { select: { username: true, displayName: true, avatarObjectKey: true } },
      agent: { select: { name: true, displayName: true, deletedAt: true, avatarObjectKey: true } },
    },
  },
  mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
  reactions: MESSAGE_REACTIONS_SELECT,
} satisfies Prisma.MessageSelect;

export type BrowserMessageRow = Prisma.MessageGetPayload<{
  select: typeof browserMessageFields;
}>;

/** Exported for a pure unit test of this projection (no database needed). */
export function mapBrowserMessage(message: BrowserMessageRow, workspaceId: string) {
  const suggestion = message.sender?.agentId
    ? parseWeeklyReportAssistantSuggestion(message.body)
    : null;
  const weeklyReportSuggestion =
    suggestion?.type === "collect-plan" || suggestion?.type === "body-edit" ? suggestion : null;
  return {
    ...(weeklyReportSuggestion
      ? {
          weeklyReportSuggestion,
          weeklyReportDisplayBody: weeklyReportAssistantSuggestionDisplayBody(message.body),
        }
      : {}),
    id: message.id,
    sequence: message.sequence,
    threadRootId: message.threadRootId ?? undefined,
    senderMemberId: message.senderMemberId,
    senderKind: !message.sender
      ? ("system" as const)
      : message.sender.userId
        ? ("user" as const)
        : ("agent" as const),
    senderName: browserSenderName(message.sender),
    senderHandle: browserSenderHandle(message.sender),
    /** The sender's Agent id, present only for an Agent-sent message; opens the Agent profile
     * panel from a message row (`features/agents/profile-panel/`). */
    senderAgentId: message.sender?.agentId ?? undefined,
    /** True when the sending Agent has since been deleted: the row renders its sender
     * greyed with a `DELETED` marker, and no longer opens that Agent's profile. */
    senderDeleted: Boolean(message.sender?.agent?.deletedAt),
    senderAvatarUrl: browserSenderAvatarUrl(message.sender, workspaceId),
    body: message.body,
    // An ISO string, not a `Date`: TanStack Query's structural sharing keeps an unchanged
    // message's cached object across a re-read only for JSON-compatible values, and a new object
    // re-renders its memoized row.
    createdAt: message.createdAt.toISOString(),
    mentions: message.mentions.map(browserMessageMention),
    attachments: message.attachments.map((attachment) => attachmentView(attachment)),
    reactions: reactionSummaries(message.reactions),
    // Attached by the caller (`conversations.functions.ts`, `ActionCards.viewsFor`) in one
    // batched lookup per page; this function never queries `ActionCard` rows itself.
    actionCard: undefined as ActionCardView | undefined,
  };
}

/**
 * What arrived in a conversation after a window read (`ConversationUpdatesCursor`): every message
 * after `afterSequence`, or, once `afterReplySequence` is given, every top-level message after
 * `afterSequence` and only the replies after `afterReplySequence`.
 */
export function messagesArrivedWhere(
  conversationId: string,
  afterSequence: number,
  afterReplySequence: number = afterSequence,
): Prisma.MessageWhereInput {
  if (afterReplySequence === afterSequence)
    return { conversationId, sequence: { gt: afterSequence } };
  return {
    conversationId,
    OR: [
      { threadRootId: null, sequence: { gt: afterSequence } },
      { threadRootId: { not: null }, sequence: { gt: afterReplySequence } },
    ],
  };
}

/** A direct conversation's message for the browser: the shared projection without
 * `senderMemberId`, which a direct conversation's stream does not send; its pane then tells the
 * viewer's own messages by `senderKind`. */
export function mapDirectBrowserMessage(message: BrowserMessageRow, workspaceId: string) {
  const { senderMemberId: _senderMemberId, ...view } = mapBrowserMessage(message, workspaceId);
  return view;
}

/** Bounded browser history reads shared by direct conversations and public channels. */
export class ConversationHistory {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Resolves to the viewer's own member row in the conversation, if they have one (a Workspace
   * member may read a public channel without joining it), and the row again as `activeMemberId`
   * only while they have not left: a member who left reads the read-only preview, with none of
   * the read cursors, follows or unread their old row kept.
   */
  async authorize(
    workspaceId: string,
    userId: string,
    conversationId: string,
  ): Promise<{
    viewerMemberId: string | undefined;
    activeMemberId: string | undefined;
    direct: boolean;
  }> {
    const [membership, conversation] = await Promise.all([
      this.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { userId: true },
      }),
      this.db.conversation.findFirst({
        // A channel hidden from the Workspace is unreadable for everyone until it is restored.
        where: { id: conversationId, workspaceId, ...VISIBLE_CONVERSATION_WHERE },
        select: {
          directKey: true,
          channelName: true,
          members: { where: { userId }, select: { id: true, leftAt: true } },
        },
      }),
    ]);
    if (!membership) throw new AppError("ACCESS_DENIED");
    if (!conversation) throw new AppError("NOT_FOUND");
    const viewer = conversation.members[0];
    const viewerMemberId = viewer?.id;
    const activeMemberId = viewer?.leftAt === null ? viewer.id : undefined;
    if (conversation.channelName !== null) return { viewerMemberId, activeMemberId, direct: false };
    if (conversation.directKey !== null && viewerMemberId)
      return { viewerMemberId, activeMemberId, direct: true };
    throw new AppError("ACCESS_DENIED");
  }

  async listOwnMessages(
    workspaceId: string,
    userId: string,
    conversationId: string,
    page: { beforeSequence?: number; limit?: number } = {},
  ) {
    const { viewerMemberId } = await this.authorize(workspaceId, userId, conversationId);
    // A viewer who never joined has sent nothing here.
    if (!viewerMemberId) return { hasOlder: false, messages: [] };
    const limit = Math.min(Math.max(page.limit ?? 20, 1), 50);
    const rows = await this.db.message.findMany({
      where: {
        conversationId,
        threadRootId: null,
        sequence: page.beforeSequence ? { lt: page.beforeSequence } : undefined,
        // By the member row (one per user per conversation, kept after leaving), not a join
        // through `sender.userId`: that walked the conversation's whole history backwards to find
        // the viewer's rows; this is a range on `messages(senderMemberId, threadRootId, sequence)`.
        senderMemberId: viewerMemberId,
      },
      orderBy: { sequence: "desc" },
      take: limit + 1,
      select: {
        id: true,
        sequence: true,
        body: true,
        createdAt: true,
        attachments: {
          select: { fileName: true },
          orderBy: { position: "asc" as const },
        },
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
          attachmentFileName: attachmentFileNameSummary(message.attachments),
        })),
    };
  }

  /**
   * The window around one message, or around its thread's root when the message is a reply (the
   * answer then names that root, `anchorThreadRootId`: a link to a reply opens its thread). Only
   * top-level messages come back, each thread as a summary; the same fields of the viewer's
   * threads that a page carries come with them, for these roots only.
   */
  async loadAround(
    workspaceId: string,
    userId: string,
    conversationId: string,
    messageId: string,
    requestedLimit = 41,
  ) {
    const { activeMemberId, direct } = await this.authorize(workspaceId, userId, conversationId);
    // The anchor is any message in this conversation. No sender filter: a saved jump (#127) lands
    // on other members' and Agent messages too, and the viewer's membership — checked just
    // above — is the whole access decision. (The notification deep link only ever targeted the
    // viewer's own sends, which is where the old `sender: { userId }` came from; it made every
    // other-sender anchor a NOT_FOUND and the jump read as a history-load failure.)
    const anchor = await this.db.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true, sequence: true, threadRoot: { select: { id: true, sequence: true } } },
    });
    if (!anchor) throw new AppError("NOT_FOUND");
    const center = anchor.threadRoot ?? anchor;

    const limit = Math.min(Math.max(requestedLimit, 1), 81);
    const beforeCount = Math.floor((limit - 1) / 2);
    const afterCount = limit - beforeCount - 1;
    const [beforeRows, afterRows] = await Promise.all([
      this.db.message.findMany({
        where: {
          conversationId,
          threadRootId: null,
          sequence: { lte: center.sequence },
        },
        orderBy: { sequence: "desc" },
        take: beforeCount + 2,
        select: browserMessageFields,
      }),
      this.db.message.findMany({
        where: {
          conversationId,
          threadRootId: null,
          sequence: { gt: center.sequence },
        },
        orderBy: { sequence: "asc" },
        take: afterCount + 1,
        select: browserMessageFields,
      }),
    ]);
    const roots = [
      ...beforeRows.slice(0, beforeCount + 1).reverse(),
      ...afterRows.slice(0, afterCount),
    ];
    const rootIds = roots.map((message) => message.id);
    const [{ threads, threadReadThrough }, followed] = await Promise.all([
      readWindowThreads(this.db, {
        workspaceId,
        conversationId,
        rootIds,
        viewerMemberId: activeMemberId,
      }),
      direct ? [] : followedThreadRootIds(this.db, { viewerMemberId: activeMemberId, rootIds }),
    ]);
    return {
      conversationId,
      hasOlder: beforeRows.length > beforeCount + 1,
      hasNewer: afterRows.length > afterCount,
      anchorThreadRootId: anchor.threadRoot?.id,
      messages: roots.map((message) => mapBrowserMessage(message, workspaceId)),
      threads,
      threadReadThrough,
      followedThreadRootIds: followed,
    };
  }

  /**
   * Every reply of one thread, oldest first, system notices included: what its pane shows. Read
   * under the same rule as the conversation's window (`authorize`); `NOT_FOUND` unless the message
   * is a top-level message of this conversation.
   */
  async loadThread(
    workspaceId: string,
    userId: string,
    conversationId: string,
    threadRootId: string,
  ) {
    const { direct } = await this.authorize(workspaceId, userId, conversationId);
    // The replies are read beside the check that their root is a top-level message here: nothing
    // is returned before it passes.
    const [root, replies] = await Promise.all([
      this.db.message.findFirst({
        where: { id: threadRootId, conversationId, threadRootId: null },
        select: { id: true },
      }),
      this.db.message.findMany({
        where: { conversationId, threadRootId },
        orderBy: { sequence: "asc" },
        select: browserMessageFields,
      }),
    ]);
    if (!root) throw new AppError("NOT_FOUND");
    return {
      replies: replies.map((reply) =>
        direct
          ? mapDirectBrowserMessage(reply, workspaceId)
          : mapBrowserMessage(reply, workspaceId),
      ),
    };
  }
}
