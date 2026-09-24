import type { PrismaClient } from "#src/generated/prisma/client";
import { Prisma } from "#src/generated/prisma/client";
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
import { browserSenderName } from "#src/server/conversations/sender-display.server";

/**
 * A person's Activity inbox: every joined channel and direct message, every channel thread they
 * follow, and every thread in their direct messages, as long as it has activity past the point
 * where they marked it Done. Reading an item never removes it; Done does, until a newer message
 * arrives.
 *
 * Unread follows the Chat sidebar's rule (other people's messages past the read cursor or the
 * mark-as-unread marker; the viewer's own messages and system notices never count), so the two
 * surfaces always agree. A conversation item covers top-level messages only; a thread item
 * covers its replies and keeps its read and Done boundaries in `thread_reads`.
 */

/** One conversation or thread in the inbox, keyed `conversation:<id>` or `thread:<rootId>`. */
type ActivityCandidate = {
  kind: "channel" | "direct" | "thread";
  memberId: string;
  conversationId: string;
  rootMessageId: string | null;
  channelName: string | null;
  agentId: string | null;
  followed: boolean | null;
  latestMessageId: string;
  latestSequence: number;
  latestAt: Date;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  firstMentionMessageId: string | null;
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
    const page = candidates.slice(offset, offset + limit);
    const items = await this.hydrate(workspaceId, page);
    return {
      items,
      totalCount: candidates.length,
      totalUnreadCount: candidates.reduce((sum, candidate) => sum + candidate.unreadCount, 0),
      hasMore: offset + limit < candidates.length,
    };
  }

  /**
   * Marks one item Done through the newest message the viewer saw (`throughSequence`), which also
   * reads it: a message that arrived after the viewer's render keeps the item listed. Both
   * boundaries only move forward and are clamped to the item's own newest message.
   */
  async markDone(workspaceId: string, userId: string, item: ActivityItemDone) {
    await this.authorize(workspaceId, userId);
    const member = await this.db.conversationMember.findFirst({
      where: {
        conversationId: item.conversationId,
        workspaceId,
        userId,
        ...ACTIVE_MEMBER_WHERE,
      },
      select: { id: true },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    if (item.kind === "conversation") {
      const latest = await this.db.message.findFirst({
        where: { conversationId: item.conversationId, threadRootId: null },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const boundary = Math.min(item.throughSequence, latest?.sequence ?? 0);
      if (boundary < 1) return;
      await this.db.$executeRaw`
        UPDATE "conversation_members"
        SET "doneThroughSequence" = GREATEST(COALESCE("doneThroughSequence", 0), ${boundary}),
            "readThroughSequence" = GREATEST("readThroughSequence", ${boundary}),
            "unreadFromSequence" = CASE
              WHEN "unreadFromSequence" <= ${boundary} THEN NULL ELSE "unreadFromSequence" END
        WHERE "id" = ${member.id}::uuid`;
      return;
    }
    const latest = await this.db.message.findFirst({
      where: { conversationId: item.conversationId, threadRootId: item.rootMessageId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const boundary = Math.min(item.throughSequence, latest?.sequence ?? 0);
    if (boundary < 1) return;
    await this.db.$executeRaw`
      INSERT INTO "thread_reads"
        ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence",
         "doneThroughSequence")
      VALUES (${member.id}::uuid, ${item.conversationId}::uuid, ${workspaceId}::uuid,
        ${item.rootMessageId}::uuid, ${boundary}, ${boundary})
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET
        "readThroughSequence" = GREATEST("thread_reads"."readThroughSequence", ${boundary}),
        "doneThroughSequence" =
          GREATEST(COALESCE("thread_reads"."doneThroughSequence", 0), ${boundary})`;
  }

  /**
   * Reads everything the inbox can show: every joined conversation through its newest top-level
   * message (clearing any mark-as-unread marker) and every listed thread through its newest
   * reply. Items stay listed; only Done removes them.
   */
  async markAllRead(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    await this.db.$transaction([
      this.db.$executeRaw`
        UPDATE "conversation_members" cm
        SET "readThroughSequence" = GREATEST(cm."readThroughSequence", latest."sequence"),
            "unreadFromSequence" = NULL
        FROM "conversation_members" viewer
        CROSS JOIN LATERAL (
          SELECT m."sequence" FROM "messages" m
          WHERE m."conversationId" = viewer."conversationId" AND m."threadRootId" IS NULL
          ORDER BY m."sequence" DESC LIMIT 1
        ) latest
        WHERE cm."id" = viewer."id"
          AND viewer."userId" = ${userId}::uuid
          AND viewer."workspaceId" = ${workspaceId}::uuid
          AND viewer."leftAt" IS NULL`,
      this.db.$executeRaw`
        INSERT INTO "thread_reads"
          ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
        SELECT threads."memberId", threads."conversationId", ${workspaceId}::uuid,
          threads."rootMessageId", latest."sequence"
        FROM (${threadRootsSql(workspaceId, userId)}) threads
        CROSS JOIN LATERAL (
          SELECT m."sequence" FROM "messages" m
          WHERE m."conversationId" = threads."conversationId"
            AND m."threadRootId" = threads."rootMessageId"
          ORDER BY m."sequence" DESC LIMIT 1
        ) latest
        ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
          GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`,
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
          NULL::boolean AS "followed",
          latest."id" AS "latestMessageId",
          latest."sequence" AS "latestSequence",
          latest."createdAt" AS "latestAt",
          unread."count" AS "unreadCount",
          unread."firstId" AS "firstUnreadMessageId",
          mention."firstId" AS "firstMentionMessageId",
          mention."firstId" IS NOT NULL AS "mentioned",
          COALESCE(mention."unread", FALSE) AS "unreadMention",
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
            AND m."senderMemberId" IS NOT NULL
            AND m."senderMemberId" <> cm."id"
            AND (
              m."sequence" > cm."readThroughSequence"
              OR cm."unreadFromSequence" IS NOT NULL AND m."sequence" >= cm."unreadFromSequence"
            )
        ) unread
        LEFT JOIN LATERAL (
          SELECT (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId",
            BOOL_OR(
              m."sequence" > cm."readThroughSequence"
              OR cm."unreadFromSequence" IS NOT NULL AND m."sequence" >= cm."unreadFromSequence"
            ) AS "unread"
          FROM "message_mentions" mm
          JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
          WHERE mm."memberId" = cm."id"
            AND m."threadRootId" IS NULL
            AND m."sequence" > COALESCE(cm."doneThroughSequence", 0)
        ) mention ON TRUE
        WHERE cm."userId" = ${userId}::uuid
          AND cm."workspaceId" = ${workspaceId}::uuid
          AND cm."leftAt" IS NULL
          AND (c."channelName" IS NOT NULL OR peer."agentId" IS NOT NULL)
          AND latest."sequence" > COALESCE(cm."doneThroughSequence", 0)`,
      this.db.$queryRaw<ActivityCandidate[]>`
        SELECT
          'thread' AS "kind",
          threads."memberId" AS "memberId",
          threads."conversationId" AS "conversationId",
          threads."rootMessageId" AS "rootMessageId",
          threads."channelName" AS "channelName",
          threads."agentId" AS "agentId",
          threads."followed" AS "followed",
          latest."id" AS "latestMessageId",
          latest."sequence" AS "latestSequence",
          latest."createdAt" AS "latestAt",
          replies."unread" AS "unreadCount",
          replies."firstUnreadId" AS "firstUnreadMessageId",
          mention."firstId" AS "firstMentionMessageId",
          mention."firstId" IS NOT NULL AS "mentioned",
          COALESCE(mention."unread", FALSE) AS "unreadMention",
          replies."count" AS "replyCount"
        FROM (${threadRootsSql(workspaceId, userId)}) threads
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
        LEFT JOIN LATERAL (
          SELECT (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId",
            BOOL_OR(m."sequence" > COALESCE(tr."readThroughSequence", 0)) AS "unread"
          FROM "message_mentions" mm
          JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
          WHERE mm."memberId" = threads."memberId"
            AND m."threadRootId" = threads."rootMessageId"
            AND m."sequence" > COALESCE(tr."doneThroughSequence", 0)
        ) mention ON TRUE
        WHERE latest."sequence" > COALESCE(tr."doneThroughSequence", 0)`,
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
          status: task.status,
          ownerName: task.owner ? browserSenderName(task.owner) : null,
        },
      ]),
    );
    return page.flatMap((candidate) => {
      const latest = messageById.get(candidate.latestMessageId);
      if (!latest) return [];
      const root = candidate.rootMessageId ? messageById.get(candidate.rootMessageId) : undefined;
      return [
        {
          key: candidate.rootMessageId
            ? `thread:${candidate.rootMessageId}`
            : `conversation:${candidate.conversationId}`,
          kind: candidate.kind,
          conversationId: candidate.conversationId,
          rootMessageId: candidate.rootMessageId,
          channelName: candidate.channelName,
          agent: candidate.agentId ? (agentById.get(candidate.agentId) ?? null) : null,
          followed: candidate.followed,
          latest,
          latestSequence: candidate.latestSequence,
          root: root ?? null,
          task: candidate.rootMessageId ? (taskByRoot.get(candidate.rootMessageId) ?? null) : null,
          replyCount: candidate.replyCount,
          unreadCount: candidate.unreadCount,
          firstUnreadMessageId: candidate.firstUnreadMessageId,
          firstMentionMessageId: candidate.firstMentionMessageId,
          mentioned: candidate.mentioned,
          unreadMention: candidate.unreadMention,
        },
      ];
    });
  }
}

/** A reply that is unread for the thread's viewer: someone else's, past their thread cursor. */
const unreadReplySql = Prisma.sql`m."senderMemberId" IS NOT NULL
  AND m."senderMemberId" <> threads."memberId"
  AND m."sequence" > COALESCE(tr."readThroughSequence", 0)`;

/**
 * The threads the inbox follows for one viewer: channel threads they follow, and every thread in
 * their direct messages with a live Agent (a direct message has no follow switch; it is theirs).
 * Archived channels and conversations they left are out.
 */
function threadRootsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT tf."rootMessageId", cm."id" AS "memberId", cm."conversationId",
      c."channelName", NULL::uuid AS "agentId", TRUE AS "followed"
    FROM "thread_follows" tf
    JOIN "conversation_members" cm ON cm."id" = tf."memberId"
    JOIN "conversations" c
      ON c."id" = cm."conversationId" AND c."archivedAt" IS NULL AND c."channelName" IS NOT NULL
    WHERE cm."userId" = ${userId}::uuid
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND cm."leftAt" IS NULL
    UNION ALL
    SELECT DISTINCT r."threadRootId" AS "rootMessageId", cm."id" AS "memberId",
      cm."conversationId", NULL AS "channelName", am."agentId", NULL::boolean AS "followed"
    FROM "conversation_members" cm
    JOIN "conversations" c ON c."id" = cm."conversationId" AND c."directKey" IS NOT NULL
    JOIN "conversation_members" am
      ON am."conversationId" = cm."conversationId" AND am."agentId" IS NOT NULL
    JOIN "agents" a ON a."id" = am."agentId" AND a."deletedAt" IS NULL
    JOIN "messages" r ON r."conversationId" = cm."conversationId" AND r."threadRootId" IS NOT NULL
    WHERE cm."userId" = ${userId}::uuid
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND cm."leftAt" IS NULL`;
}
