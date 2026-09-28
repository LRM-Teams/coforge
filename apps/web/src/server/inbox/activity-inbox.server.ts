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
  directThreadsSql,
  followedChannelThreadsSql,
  humanUnreadReplySql,
  markConversationDoneSql,
  markConversationsReadSql,
  markThreadDoneSql,
  markThreadsReadSql,
} from "#src/server/conversations/human-unread.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import { storedTaskStatus } from "#src/server/tasks/task-view.server";

/**
 * A person's Activity inbox: every joined channel and direct message, every channel thread they
 * follow, and every thread in their direct messages, as long as it has activity past the point
 * where they marked it Done. Reading an item never removes it; Done does, until a newer message
 * arrives. It also lists each message whose sender had them notified of a mention from outside
 * that channel, until they mark it Done.
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
  /** A mention the viewer was notified of from outside the channel, until they mark it Done. */
  mentionAction?: { resolutionId: string; threadRootId: string | null };
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
    // Read before the list, on the clock message `createdAt` values come from: Prisma fills them in
    // this process (`@default(now())` is generated client-side).
    const loadedAt = new Date();
    // What every candidate must carry. The default list only sorts candidates, so it asks for
    // identities and the sort keys alone and lets the page read its own rows; a filter that selects
    // on unread must read unread for every candidate, and only the mention filter needs mentions for
    // all of them.
    const context =
      options.filter === "mentions"
        ? { withUnread: true, withMention: true }
        : options.filter === "unread"
          ? { withUnread: true, withMention: false }
          : { withUnread: false, withMention: false };
    const [all, unreadTotal] = await Promise.all([
      this.candidates(workspaceId, userId, context),
      // The page's total is this same number unless a mention filter narrows the list; the mention
      // path sums the per-candidate values it already read.
      options.filter === "mentions"
        ? Promise.resolve(undefined)
        : this.unreadTotal(workspaceId, userId),
    ]);
    const candidates = all.filter((candidate) =>
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
      items: await this.hydrate(workspaceId, userId, candidates.slice(offset, end), {
        // The mention filter read both for every candidate, so the page has nothing to fill; the
        // other filters did not, and the page reads its own rows through the same query.
        fillContext: options.filter !== "mentions",
      }),
      totalCount: candidates.length,
      totalUnreadCount:
        unreadTotal ?? candidates.reduce((sum, candidate) => sum + candidate.unreadCount, 0),
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
    if (item.kind === "mention_action") {
      await this.db.pendingMentionAction.updateMany({
        where: { id: item.resolutionId, workspaceId, targetUserId: userId, dismissedAt: null },
        data: { dismissedAt: new Date() },
      });
      return;
    }
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
        ? markThreadDoneSql(
            {
              memberId: member.id,
              conversationId: item.conversationId,
              workspaceId,
              rootMessageId,
            },
            boundary,
          )
        : markConversationDoneSql(member.id, boundary),
    );
  }

  /**
   * The viewer's total unread activity count, without listing items — what the nav rail's Activity
   * dot reads. Same candidates the inbox lists, so Done and read move it exactly like the page.
   */
  async navAttention(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    return { unread: await this.unreadTotal(workspaceId, userId) };
  }

  /**
   * The viewer's total unread activity, in one statement: the same three terms the inbox lists —
   * joined conversations, followed threads and notified mentions — each counted from the item's own
   * read boundary up. Every online viewer re-reads this on each Workspace message, and the page's
   * total is this same number whenever no mention filter narrows the list, so both share the SQL
   * rather than one of them re-deriving it a row at a time.
   */
  private async unreadTotal(workspaceId: string, userId: string): Promise<number> {
    const [{ unread }] = await this.db.$queryRaw<[{ unread: number }]>`
      SELECT ((
        SELECT COUNT(*) FROM ${conversationItemsSql(workspaceId, userId)}
        JOIN "messages" m
          ON m."conversationId" = cm."conversationId"
         AND m."threadRootId" IS NULL
         AND ${HUMAN_UNREAD_MESSAGE_SQL}
        WHERE ${CONVERSATION_ITEM_LISTED_SQL}
      ) + (
        SELECT COUNT(*) FROM ${threadItemsSql(workspaceId, userId)}
        JOIN "messages" m
          ON m."conversationId" = threads."conversationId"
         AND m."threadRootId" = threads."rootMessageId"
         AND ${unreadReplySql}
        WHERE ${THREAD_ITEM_LISTED_SQL}
      ) + (
        -- Each notified mention is one unread item until the viewer reads it.
        SELECT COUNT(*) FROM "pending_mention_actions" pma
        JOIN "conversations" pc ON pc."id" = pma."conversationId"
         AND pc."archivedAt" IS NULL AND pc."hiddenFromWorkspaceAt" IS NULL
        WHERE pma."workspaceId" = ${workspaceId}::uuid AND pma."targetUserId" = ${userId}::uuid
          AND pma."notifiedAt" IS NOT NULL AND pma."dismissedAt" IS NULL
          AND pma."targetReadAt" IS NULL
      ))::int AS "unread"`;
    return unread;
  }

  /** Reads or unreads a mention the viewer was notified of; it stays listed until Done. */
  async setMentionRead(workspaceId: string, userId: string, resolutionId: string, read: boolean) {
    await this.authorize(workspaceId, userId);
    await this.db.pendingMentionAction.updateMany({
      where: { id: resolutionId, workspaceId, targetUserId: userId, notifiedAt: { not: null } },
      data: { targetReadAt: read ? new Date() : null },
    });
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
      this.db.pendingMentionAction.updateMany({
        where: {
          workspaceId,
          targetUserId: userId,
          notifiedAt: { not: null, lte: before },
          targetReadAt: null,
        },
        data: { targetReadAt: new Date() },
      }),
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
  private async candidates(
    workspaceId: string,
    userId: string,
    // What the caller actually needs from every candidate. The default reads everything, which is
    // what this method always did; a caller that only sorts (and fills the rest for its page) can
    // turn the laterals off and get the identities and the sort keys alone.
    context: { withUnread: boolean; withMention: boolean } = {
      withUnread: true,
      withMention: true,
    },
    // When set, only these candidates are read. The page reader asks for the rows it renders rather
    // than every followed thread; two lists because the branches key differently, and both halves of
    // each tuple are NOT NULL, so the comparison is exact rather than `IN` with a NULL hole.
    only?: {
      conversationItems: ReadonlyArray<readonly [string, string]>;
      threadItems: ReadonlyArray<readonly [string, string]>;
    },
  ): Promise<ActivityCandidate[]> {
    // An empty list is not `IN ()` — it is "nothing matches", which is what FALSE says.
    const conversationOnly = !only
      ? Prisma.empty
      : only.conversationItems.length === 0
        ? Prisma.sql` AND FALSE`
        : Prisma.sql` AND (cm."id", cm."conversationId") IN (${Prisma.join(
            only.conversationItems.map(
              ([memberId, conversationId]) =>
                Prisma.sql`(${memberId}::uuid, ${conversationId}::uuid)`,
            ),
            ", ",
          )})`;
    const threadOnly = !only
      ? Prisma.empty
      : only.threadItems.length === 0
        ? Prisma.sql` AND FALSE`
        : Prisma.sql` AND (threads."memberId", threads."rootMessageId") IN (${Prisma.join(
            only.threadItems.map(
              ([memberId, rootMessageId]) =>
                Prisma.sql`(${memberId}::uuid, ${rootMessageId}::uuid)`,
            ),
            ", ",
          )})`;
    // Three independent reads: a list is built from top-level items, thread items and mention
    // items, and none of them depends on the others. Starting them together means the page waits
    // for the slowest instead of for two waves.
    const [conversations, threads, mentions] = await Promise.all([
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
          ${
            context.withUnread
              ? Prisma.sql`unread."count" AS "unreadCount",
          unread."firstId" AS "firstUnreadMessageId",`
              : Prisma.sql`0 AS "unreadCount",
          NULL::uuid AS "firstUnreadMessageId",`
          }
          ${
            context.withMention
              ? Prisma.sql`mention."any" AS "mentioned",
          mention."unread" AS "unreadMention"`
              : Prisma.sql`FALSE AS "mentioned",
          FALSE AS "unreadMention"`
          }
        FROM ${conversationItemsSql(workspaceId, userId)}
        ${context.withUnread ? conversationUnreadLateral : Prisma.empty}
        ${context.withMention ? conversationMentionLateral : Prisma.empty}
        WHERE ${CONVERSATION_ITEM_LISTED_SQL}${conversationOnly}`,
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
          ${
            context.withUnread
              ? Prisma.sql`replies."unread" AS "unreadCount",
          replies."firstUnreadId" AS "firstUnreadMessageId",`
              : Prisma.sql`0 AS "unreadCount",
          NULL::uuid AS "firstUnreadMessageId",`
          }
          ${
            context.withMention
              ? Prisma.sql`mention."any" AS "mentioned",
          mention."unread" AS "unreadMention"`
              : Prisma.sql`FALSE AS "mentioned",
          FALSE AS "unreadMention"`
          }
        FROM ${threadItemsSql(workspaceId, userId)}
        ${context.withUnread ? threadUnreadLateral : Prisma.empty}
        ${context.withMention ? threadMentionLateral : Prisma.empty}
        WHERE ${THREAD_ITEM_LISTED_SQL}${threadOnly}`,
      this.mentionCandidates(workspaceId, userId),
    ]);
    return [...conversations, ...threads, ...mentions];
  }

  /**
   * Each message whose sender had the viewer notified of a mention from outside its channel, until
   * the viewer marks it Done: one mention item per notification, listed from when it was sent,
   * unread until the viewer reads it. Not in a hidden or archived channel.
   */
  private async mentionCandidates(workspaceId: string, userId: string) {
    const rows = await this.db.pendingMentionAction.findMany({
      where: {
        workspaceId,
        targetUserId: userId,
        notifiedAt: { not: null },
        dismissedAt: null,
        message: { conversation: { archivedAt: null, hiddenFromWorkspaceAt: null } },
      },
      select: {
        id: true,
        conversationId: true,
        messageId: true,
        notifiedAt: true,
        targetReadAt: true,
        message: {
          select: {
            sequence: true,
            threadRootId: true,
            conversation: { select: { channelName: true } },
          },
        },
      },
    });
    return rows.map((row): ActivityCandidate => ({
      kind: "channel",
      memberId: "",
      conversationId: row.conversationId,
      rootMessageId: null,
      channelName: row.message.conversation.channelName,
      agentId: null,
      latestMessageId: row.messageId,
      latestSequence: row.message.sequence,
      latestAt: row.notifiedAt!,
      unreadCount: row.targetReadAt ? 0 : 1,
      firstUnreadMessageId: row.targetReadAt ? null : row.messageId,
      mentioned: true,
      unreadMention: !row.targetReadAt,
      mentionAction: { resolutionId: row.id, threadRootId: row.message.threadRootId },
    }));
  }

  /** Loads the messages, Agents, tasks and thread reply totals one page of items renders, in one
   * query each. */
  private async hydrate(
    workspaceId: string,
    userId: string,
    page: readonly ActivityCandidate[],
    // True when the list did not read unread/mention for every candidate (see `list`): the page
    // then reads them for its own rows, from the same query narrowed by identity, so what a rendered
    // row shows cannot drift from what the filter and the counts used.
    { fillContext }: { fillContext: boolean },
  ) {
    // The page's own identities, split the way the two branches key their rows.
    const conversationItems: Array<[string, string]> = [];
    const threadItems: Array<[string, string]> = [];
    for (const candidate of page) {
      // A notified mention renders its own item shape; it has no context row to read.
      if (candidate.mentionAction) continue;
      if (candidate.rootMessageId) threadItems.push([candidate.memberId, candidate.rootMessageId]);
      else conversationItems.push([candidate.memberId, candidate.conversationId]);
    }
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
    const [messages, agents, tasks, replyCounts, pageContext] = await Promise.all([
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
              agent: { select: { name: true, displayName: true, deletedAt: true } },
            },
          },
        },
      }),
      // A reply total counts people's replies, read or not; a system notice is not a reply.
      this.db.message.groupBy({
        by: ["threadRootId"],
        where: { workspaceId, threadRootId: { in: rootIds }, senderMemberId: { not: null } },
        _count: { _all: true },
      }),
      fillContext
        ? this.candidates(
            workspaceId,
            userId,
            { withUnread: true, withMention: true },
            { conversationItems, threadItems },
          )
        : Promise.resolve([]),
    ]);
    const contextByIdentity = new Map(
      pageContext.map((candidate) => [activityCandidateIdentity(candidate), candidate]),
    );
    const replyCountByRoot = new Map(replyCounts.map((row) => [row.threadRootId, row._count._all]));
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
          // A deleted Agent keeps its Tasks; the card says so instead of reading as a live owner.
          ownerDeleted: Boolean(task.owner?.agent?.deletedAt),
        },
      ]),
    );
    return page.flatMap((candidate) => {
      // Unread and mention come from the page-scoped read when the list did not compute them for
      // every candidate; otherwise they are the candidate's own values. Same shape either way, so
      // the item below reads one object.
      const context = contextByIdentity.get(activityCandidateIdentity(candidate)) ?? candidate;
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
          key: candidate.mentionAction
            ? `mention:${candidate.mentionAction.resolutionId}`
            : candidate.rootMessageId
              ? `thread:${candidate.rootMessageId}`
              : `conversation:${candidate.conversationId}`,
          place,
          // A channel thread is listed because the viewer follows it; a direct-message thread
          // has no follow switch.
          thread: root
            ? {
                root,
                replyCount: replyCountByRoot.get(root.id) ?? 0,
                task: taskByRoot.get(root.id) ?? null,
              }
            : null,
          latest,
          latestSequence: candidate.latestSequence,
          unreadCount: context.unreadCount,
          firstUnreadMessageId: context.firstUnreadMessageId,
          mentioned: context.mentioned,
          unreadMention: context.unreadMention,
          mentionAction: candidate.mentionAction ?? null,
        },
      ];
    });
  }
}

/** One candidate's identity across the two branches: the same row resolves to the same value
 * whether the list read it for every candidate or the page read it for these rows. */
function activityCandidateIdentity(candidate: {
  kind: string;
  memberId: string;
  conversationId: string;
  rootMessageId: string | null;
}) {
  return `${candidate.kind}|${candidate.memberId}|${candidate.conversationId}|${candidate.rootMessageId ?? ""}`;
}

/** A reply unread for the thread's viewer (the candidate query's `threads` and `tr` rows). */
const unreadReplySql = humanUnreadReplySql(
  Prisma.sql`threads."memberId"`,
  Prisma.sql`tr."readThroughSequence"`,
);

/**
 * The per-candidate context laterals, as fragments rather than inline SQL.
 *
 * The list reads them for every candidate, the page reads them for the handful it renders, and the
 * two must agree exactly — so they are one piece of SQL used in both places. Each names the aliases
 * its `FROM` provides (`cm` for conversations, `threads`/`tr` for threads), which is why they cannot
 * simply be parameterised by scope: the reuse is what keeps the two readers honest.
 */
const conversationUnreadLateral = Prisma.sql`CROSS JOIN LATERAL (
  SELECT COUNT(*)::int AS "count",
    (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
  FROM "messages" m
  WHERE m."conversationId" = cm."conversationId"
    AND m."threadRootId" IS NULL
    AND ${HUMAN_UNREAD_MESSAGE_SQL}
) unread`;

const conversationMentionLateral = Prisma.sql`CROSS JOIN LATERAL (
  SELECT COUNT(*) > 0 AS "any",
    COALESCE(BOOL_OR(${HUMAN_UNREAD_MESSAGE_SQL}), FALSE) AS "unread"
  FROM "message_mentions" mm
  JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
  WHERE mm."memberId" = cm."id"
    AND m."threadRootId" IS NULL
    AND m."sequence" > COALESCE(cm."doneThroughSequence", 0)
) mention`;

const threadUnreadLateral = Prisma.sql`CROSS JOIN LATERAL (
  SELECT COUNT(*)::int AS "unread",
    (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstUnreadId"
  FROM "messages" m
  WHERE m."conversationId" = threads."conversationId"
    AND m."threadRootId" = threads."rootMessageId"
    AND ${unreadReplySql}
) replies`;

const threadMentionLateral = Prisma.sql`CROSS JOIN LATERAL (
  SELECT COUNT(*) > 0 AS "any", COALESCE(BOOL_OR(${unreadReplySql}), FALSE) AS "unread"
  FROM "messages" m
  JOIN "message_mentions" mm
    ON mm."messageId" = m."id"
   AND mm."memberId" = threads."memberId"
   AND mm."conversationId" = m."conversationId"
  WHERE m."conversationId" = threads."conversationId"
    AND m."threadRootId" = threads."rootMessageId"
    AND m."sequence" > COALESCE(tr."doneThroughSequence", 0)
) mention`;

/**
 * The viewer's joined conversations with their Agent peer (`peer`) and newest top-level message
 * (`latest`), as the `FROM` of an item query over `cm` and `c`. `CONVERSATION_ITEM_LISTED_SQL` is
 * its `WHERE`: the list and the nav dot share both, so they cannot disagree on what is listed.
 */
function conversationItemsSql(workspaceId: string, userId: string) {
  return Prisma.sql`"conversation_members" cm
    JOIN "conversations" c
      ON c."id" = cm."conversationId"
     AND cm."userId" = ${userId}::uuid
     AND cm."workspaceId" = ${workspaceId}::uuid
     AND cm."leftAt" IS NULL
     AND c."workspaceId" = ${workspaceId}::uuid
     AND c."archivedAt" IS NULL
     AND c."hiddenFromWorkspaceAt" IS NULL
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
    ) latest`;
}

/** A joined conversation is listed when it has an Agent peer or is a channel, with activity past Done. */
const CONVERSATION_ITEM_LISTED_SQL = Prisma.sql`(c."channelName" IS NOT NULL OR peer."agentId" IS NOT NULL)
  AND latest."sequence" > COALESCE(cm."doneThroughSequence", 0)`;

/**
 * The viewer's followed channel threads and direct-message threads (`threads`) with their
 * conversation (`c`), Agent peer (`peer`), thread cursors (`tr`) and newest reply (`latest`), as
 * the `FROM` of an item query. `THREAD_ITEM_LISTED_SQL` is its `WHERE`.
 */
function threadItemsSql(workspaceId: string, userId: string) {
  return Prisma.sql`(
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
    ) latest`;
}

/** A thread is listed with a reply past Done; a direct-message thread only with its Agent. */
const THREAD_ITEM_LISTED_SQL = Prisma.sql`latest."sequence" > COALESCE(tr."doneThroughSequence", 0)
  AND (threads."kind" = 'channel' OR peer."agentId" IS NOT NULL)`;
