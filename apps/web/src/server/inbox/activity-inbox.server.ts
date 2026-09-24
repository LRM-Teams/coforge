import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type {
  ActivityInboxFilter,
  ActivityItemDone,
} from "#src/features/inbox/activity-inbox.schemas";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  browserMessageFields,
  mapBrowserMessage,
} from "#src/server/conversations/conversation-history.server";
import {
  HUMAN_UNREAD_MESSAGE_SQL,
  advanceConversationCursorsSql,
  advanceThreadCursorsSql,
  directThreadsSql,
  followedChannelThreadsSql,
  humanUnreadReplySql,
  markConversationsReadSql,
  markThreadsReadSql,
} from "#src/server/conversations/human-unread.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import { storedTaskStatus } from "#src/server/tasks/task-board.server";

/**
 * A person's Activity inbox: every joined channel and direct message, every channel thread they
 * follow, and every thread in their direct messages, as long as it has activity past the point
 * where they marked it Done. Reading an item never removes it; Done does, until a newer message
 * arrives.
 *
 * Unread is the Chat sidebar's rule (`HUMAN_UNREAD_MESSAGE_SQL`), so the two surfaces agree. A
 * conversation item covers top-level messages only; a thread item covers its replies and keeps its
 * read and Done boundaries in `thread_reads`. Every cursor write is the conversation module's
 * shared SQL (`human-unread.server.ts`).
 */

/** One conversation or thread with activity, as the candidate query returns it. */
type ActivityCandidate = {
  kind: "channel" | "direct";
  memberId: string;
  conversationId: string;
  rootMessageId: string | null;
  channelName: string | null;
  agentId: string | null;
  latestMessageId: string;
  latestSequence: number;
  latestAt: Date;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  mentioned: boolean;
  unreadMention: boolean;
  replyCount: number;
};

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export type ActivityInboxItem = Awaited<ReturnType<ActivityInbox["list"]>>["items"][number];

export class ActivityInbox {
  constructor(private readonly db: PrismaClient) {}

  async list(
    workspaceId: string,
    userId: string,
    options: { filter: ActivityInboxFilter; offset?: number; limit?: number },
  ) {
    await this.authorize(workspaceId, userId);
    const loadedAt = new Date();
    const candidates = (await this.candidates(workspaceId, userId)).filter((candidate) =>
      options.filter === "unread"
        ? candidate.unreadCount > 0
        : options.filter === "mentions"
          ? candidate.mentioned
          : true,
    );
    candidates.sort(
      (left, right) =>
        right.latestAt.getTime() - left.latestAt.getTime() ||
        right.latestSequence - left.latestSequence,
    );
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE));
    const end = offset + limit;
    return {
      items: await this.hydrate(workspaceId, candidates.slice(offset, end)),
      totalCount: candidates.length,
      totalUnreadCount: candidates.reduce((sum, candidate) => sum + candidate.unreadCount, 0),
      /** Where the next page starts in the list, or null on the last page. */
      nextOffset: end < candidates.length ? end : null,
      /** When this list was read: Mark all read reads through it, and no further. */
      loadedAt: loadedAt.getTime(),
    };
  }

  /**
   * Marks one item Done through the newest message the viewer saw (`throughSequence`), and reads
   * it through the same message: a message that arrived after the viewer's render keeps the item
   * listed and unread. The boundary only moves forward and is clamped to the item's newest
   * message.
   */
  async markDone(workspaceId: string, userId: string, item: ActivityItemDone) {
    await this.authorize(workspaceId, userId);
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId: item.conversationId, workspaceId, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    const rootMessageId = item.kind === "thread" ? item.rootMessageId : null;
    const latest = await this.db.message.findFirst({
      where: { conversationId: item.conversationId, threadRootId: rootMessageId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const boundary = Math.min(item.throughSequence, latest?.sequence ?? 0);
    if (boundary < 1) return;
    await this.db.$executeRaw(
      rootMessageId
        ? advanceThreadCursorsSql(
            {
              memberId: member.id,
              conversationId: item.conversationId,
              workspaceId,
              rootMessageId,
            },
            boundary,
            { done: true },
          )
        : advanceConversationCursorsSql(member.id, boundary, { done: true }),
    );
  }

  /**
   * The viewer's total unread activity count, without listing items — what the nav rail's Activity
   * dot reads. Same candidates the inbox lists, so Done and read move it exactly like the page.
   */
  async navAttention(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    const candidates = await this.candidates(workspaceId, userId);
    return { unread: candidates.reduce((sum, candidate) => sum + candidate.unreadCount, 0) };
  }

  /**
   * Reads every joined conversation and every thread the inbox lists, through the newest message
   * posted at or before `before` (the list's `loadedAt`), in one transaction. Items stay listed;
   * only Done removes them.
   */
  async markAllRead(workspaceId: string, userId: string, options: { before: Date }) {
    await this.authorize(workspaceId, userId);
    const { before } = options;
    await this.db.$transaction([
      this.db.$executeRaw(markConversationsReadSql(workspaceId, userId, before)),
      this.db.$executeRaw(
        markThreadsReadSql(workspaceId, followedChannelThreadsSql(workspaceId, userId), before),
      ),
      this.db.$executeRaw(
        markThreadsReadSql(workspaceId, directThreadsSql(workspaceId, userId), before),
      ),
    ]);
  }

  private async authorize(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
  }

  /**
   * Every listed item with its counts, in two grouped statements driven from the viewer's own
   * memberships, so each message range is an index condition on
   * `messages(conversationId, threadRootId, sequence)` rather than a Workspace-wide scan.
   */
  private async candidates(workspaceId: string, userId: string): Promise<ActivityCandidate[]> {
    const [conversations, threads] = await Promise.all([
      this.db.$queryRaw<ActivityCandidate[]>`
        SELECT
          CASE WHEN c."channelName" IS NOT NULL THEN 'channel' ELSE 'direct' END AS "kind",
          cm."id" AS "memberId",
          cm."conversationId" AS "conversationId",
          NULL::uuid AS "rootMessageId",
          c."channelName" AS "channelName",
          peer."agentId" AS "agentId",
          latest."id" AS "latestMessageId",
          latest."sequence" AS "latestSequence",
          latest."createdAt" AS "latestAt",
          unread."count" AS "unreadCount",
          unread."firstId" AS "firstUnreadMessageId",
          mention."any" AS "mentioned",
          mention."unread" AS "unreadMention",
          0 AS "replyCount"
        FROM "conversation_members" cm
        JOIN "conversations" c
          ON c."id" = cm."conversationId"
         AND c."workspaceId" = ${workspaceId}::uuid
         AND c."archivedAt" IS NULL
        LEFT JOIN LATERAL (
          SELECT am."agentId" FROM "conversation_members" am
          JOIN "agents" a ON a."id" = am."agentId" AND a."deletedAt" IS NULL
          WHERE am."conversationId" = cm."conversationId" AND am."agentId" IS NOT NULL
          LIMIT 1
        ) peer ON c."directKey" IS NOT NULL
        CROSS JOIN LATERAL (
          SELECT m."id", m."sequence", m."createdAt" FROM "messages" m
          WHERE m."conversationId" = cm."conversationId" AND m."threadRootId" IS NULL
          ORDER BY m."sequence" DESC LIMIT 1
        ) latest
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::int AS "count",
            (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
          FROM "messages" m
          WHERE m."conversationId" = cm."conversationId"
            AND m."threadRootId" IS NULL
            AND ${HUMAN_UNREAD_MESSAGE_SQL}
        ) unread
        CROSS JOIN LATERAL (
          SELECT COUNT(*) > 0 AS "any",
            COALESCE(BOOL_OR(${HUMAN_UNREAD_MESSAGE_SQL}), FALSE) AS "unread"
          FROM "message_mentions" mm
          JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
          WHERE mm."memberId" = cm."id"
            AND m."threadRootId" IS NULL
            AND m."sequence" > COALESCE(cm."doneThroughSequence", 0)
        ) mention
        WHERE cm."userId" = ${userId}::uuid
          AND cm."workspaceId" = ${workspaceId}::uuid
          AND cm."leftAt" IS NULL
          AND (c."channelName" IS NOT NULL OR peer."agentId" IS NOT NULL)
          AND latest."sequence" > COALESCE(cm."doneThroughSequence", 0)`,
      this.db.$queryRaw<ActivityCandidate[]>`
        SELECT
          threads."kind" AS "kind",
          threads."memberId" AS "memberId",
          threads."conversationId" AS "conversationId",
          threads."rootMessageId" AS "rootMessageId",
          c."channelName" AS "channelName",
          peer."agentId" AS "agentId",
          latest."id" AS "latestMessageId",
          latest."sequence" AS "latestSequence",
          latest."createdAt" AS "latestAt",
          replies."unread" AS "unreadCount",
          replies."firstUnreadId" AS "firstUnreadMessageId",
          mention."any" AS "mentioned",
          mention."unread" AS "unreadMention",
          replies."count" AS "replyCount"
        FROM (
          SELECT 'channel' AS "kind", followed.* FROM (${followedChannelThreadsSql(workspaceId, userId)}) followed
          UNION ALL
          SELECT 'direct' AS "kind", direct.* FROM (${directThreadsSql(workspaceId, userId)}) direct
        ) threads
        JOIN "conversations" c ON c."id" = threads."conversationId"
        LEFT JOIN LATERAL (
          SELECT am."agentId" FROM "conversation_members" am
          JOIN "agents" a ON a."id" = am."agentId" AND a."deletedAt" IS NULL
          WHERE threads."kind" = 'direct'
            AND am."conversationId" = threads."conversationId"
            AND am."agentId" IS NOT NULL
          LIMIT 1
        ) peer ON TRUE
        LEFT JOIN "thread_reads" tr
          ON tr."memberId" = threads."memberId" AND tr."rootMessageId" = threads."rootMessageId"
        CROSS JOIN LATERAL (
          SELECT m."id", m."sequence", m."createdAt" FROM "messages" m
          WHERE m."conversationId" = threads."conversationId"
            AND m."threadRootId" = threads."rootMessageId"
          ORDER BY m."sequence" DESC LIMIT 1
        ) latest
        CROSS JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE m."senderMemberId" IS NOT NULL)::int AS "count",
            COUNT(*) FILTER (WHERE ${unreadReplySql})::int AS "unread",
            (ARRAY_AGG(m."id" ORDER BY m."sequence") FILTER (WHERE ${unreadReplySql}))[1]
              AS "firstUnreadId"
          FROM "messages" m
          WHERE m."conversationId" = threads."conversationId"
            AND m."threadRootId" = threads."rootMessageId"
        ) replies
        CROSS JOIN LATERAL (
          SELECT COUNT(*) > 0 AS "any", COALESCE(BOOL_OR(${unreadReplySql}), FALSE) AS "unread"
          FROM "message_mentions" mm
          JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
          WHERE mm."memberId" = threads."memberId"
            AND m."threadRootId" = threads."rootMessageId"
            AND m."sequence" > COALESCE(tr."doneThroughSequence", 0)
        ) mention
        WHERE latest."sequence" > COALESCE(tr."doneThroughSequence", 0)
          AND (threads."kind" = 'channel' OR peer."agentId" IS NOT NULL)`,
    ]);
    return [...conversations, ...threads];
  }

  /** Loads the messages, Agents and tasks one page of items renders, in one query each. */
  private async hydrate(workspaceId: string, page: readonly ActivityCandidate[]) {
    const messageIds = new Set<string>();
    const agentIds = new Set<string>();
    const rootIds: string[] = [];
    for (const candidate of page) {
      messageIds.add(candidate.latestMessageId);
      if (candidate.rootMessageId) {
        messageIds.add(candidate.rootMessageId);
        rootIds.push(candidate.rootMessageId);
      }
      if (candidate.agentId) agentIds.add(candidate.agentId);
    }
    const [messages, agents, tasks] = await Promise.all([
      this.db.message.findMany({
        where: { id: { in: [...messageIds] }, workspaceId },
        select: browserMessageFields,
      }),
      this.db.agent.findMany({
        where: { id: { in: [...agentIds] }, workspaceId },
        select: { id: true, name: true, displayName: true, avatarObjectKey: true },
      }),
      this.db.task.findMany({
        where: { messageId: { in: rootIds }, workspaceId },
        select: {
          messageId: true,
          number: true,
          status: true,
          owner: {
            select: {
              user: { select: { username: true, displayName: true } },
              agent: { select: { name: true, displayName: true } },
            },
          },
        },
      }),
    ]);
    const messageById = new Map(
      messages.map((message) => [message.id, mapBrowserMessage(message, workspaceId)]),
    );
    const agentById = new Map(
      agents.map((agent) => [
        agent.id,
        {
          id: agent.id,
          displayName: agent.displayName.trim() || agent.name,
          avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
        },
      ]),
    );
    const taskByRoot = new Map(
      tasks.map((task) => [
        task.messageId,
        {
          number: task.number,
          status: storedTaskStatus(task.status),
          ownerName: task.owner ? browserSenderName(task.owner) : null,
        },
      ]),
    );
    return page.flatMap((candidate) => {
      const latest = messageById.get(candidate.latestMessageId);
      const agent = candidate.agentId ? agentById.get(candidate.agentId) : undefined;
      const place =
        candidate.kind === "channel"
          ? {
              kind: "channel" as const,
              conversationId: candidate.conversationId,
              channelName: candidate.channelName ?? "",
            }
          : agent
            ? { kind: "direct" as const, conversationId: candidate.conversationId, agent }
            : null;
      const root = candidate.rootMessageId ? messageById.get(candidate.rootMessageId) : null;
      // A row deleted between the two reads leaves the page rather than rendering half an item.
      if (!latest || !place || root === undefined) return [];
      return [
        {
          key: candidate.rootMessageId
            ? `thread:${candidate.rootMessageId}`
            : `conversation:${candidate.conversationId}`,
          place,
          // A channel thread is listed because the viewer follows it; a direct-message thread
          // has no follow switch.
          thread: root
            ? { root, replyCount: candidate.replyCount, task: taskByRoot.get(root.id) ?? null }
            : null,
          latest,
          latestSequence: candidate.latestSequence,
          unreadCount: candidate.unreadCount,
          firstUnreadMessageId: candidate.firstUnreadMessageId,
          mentioned: candidate.mentioned,
          unreadMention: candidate.unreadMention,
        },
      ];
    });
  }
}

/** A reply unread for the thread's viewer (the candidate query's `threads` and `tr` rows). */
const unreadReplySql = humanUnreadReplySql(
  Prisma.sql`threads."memberId"`,
  Prisma.sql`tr."readThroughSequence"`,
);
