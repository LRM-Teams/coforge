import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type {
  ActivityInboxFilter,
  ActivityItemDone,
} from "#src/features/inbox/activity-inbox.schemas";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  announceViewerEvent,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import {
  browserMessageFields,
  mapBrowserMessage,
} from "#src/server/conversations/conversation-history.server";
import {
  HUMAN_UNREAD_MESSAGE_SQL,
  directThreadsSql,
  followedChannelThreadsSql,
  humanUnreadCounts,
  humanUnreadReplySql,
  markConversationDoneSql,
  markConversationsReadSql,
  markThreadDoneSql,
  markThreadsReadSql,
} from "#src/server/conversations/human-unread.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import { viewerDirectConversationSql } from "#src/server/conversations/viewer-direct-conversations.server";
import {
  peoplePeer,
  peoplePeerUserFields,
} from "#src/server/conversations/direct-conversation-peer.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { storedTaskStatus } from "#src/server/tasks/task-view.server";

/**
 * A person's Activity inbox: every joined channel, every direct message of theirs (with their own
 * Agent, another member, or themself: the DMs their Direct messages list holds), every channel
 * thread they follow, and every thread in those direct messages, as long as it has activity past
 * the point where they marked it Done. Reading an item never removes it; Done does, until a newer
 * message arrives. It also lists each message whose sender had them notified of a mention from
 * outside that channel, until they mark it Done. A message between members stores no mentions and
 * notifies nobody outside the DM, so a DM between members only ever lists as itself or a thread.
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
  /** A direct message's key, which names the member on the other side of a DM between people. */
  directKey: string | null;
  agentId: string | null;
  latestMessageId: string;
  latestSequence: number;
  latestAt: Date;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  unreadMention: boolean;
  /**
   * The first message past Done that mentions the viewer, read or not: the item is listed under
   * Mentions and opens there. Null when nothing past Done mentions them.
   */
  firstMentionMessageId: string | null;
  /** A mention the viewer was notified of from outside the channel, until they mark it Done. */
  mentionAction?: { resolutionId: string; threadRootId: string | null };
};

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export type ActivityInboxItem = Awaited<ReturnType<ActivityInbox["list"]>>["items"][number];

export class ActivityInbox {
  constructor(
    private readonly db: PrismaClient,
    private readonly realtime?: Pick<ConversationRealtime, "viewerChanged">,
  ) {}

  async list(
    workspaceId: string,
    userId: string,
    options: { filter: ActivityInboxFilter; offset?: number; limit?: number },
  ) {
    await this.authorize(workspaceId, userId);
    // Read before the list, on the clock message `createdAt` values come from: Prisma fills them in
    // this process (`@default(now())` is generated client-side).
    const loadedAt = new Date();
    // Every candidate carries its unread and mention state: the filters select on them and the
    // Unread and Mentions counts cover every item, whichever filter is showing.
    const all = await this.candidates(workspaceId, userId);
    const candidates = all.filter((candidate) =>
      options.filter === "unread"
        ? candidate.unreadCount > 0
        : options.filter === "mentions"
          ? candidate.firstMentionMessageId !== null
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
      items: await this.hydrate(workspaceId, userId, candidates.slice(offset, end)),
      /** How many items have something unread, whatever the filter: the Unread tab's count. */
      unreadItemCount: all.filter((candidate) => candidate.unreadCount > 0).length,
      /** How many items have an unread mention, whatever the filter: the Mentions tab's count. */
      unreadMentionItemCount: all.filter((candidate) => candidate.unreadMention).length,
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
      select: { id: true, conversation: { select: { channelName: true } } },
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
    // A conversation's Done reads it too, so its badge moves (a thread's does not touch it).
    if (!rootMessageId)
      await this.announceMarked(workspaceId, userId, [
        { conversationId: item.conversationId, channel: member.conversation.channelName !== null },
      ]);
  }

  /** Tells the person's other pages the badge each moved conversation is left with (Slack's
   * `channel_marked` / `im_marked`), as a read inside the conversation does. */
  private async announceMarked(
    workspaceId: string,
    userId: string,
    moved: readonly { conversationId: string; channel: boolean }[],
  ) {
    if (moved.length === 0) return;
    const counts = await humanUnreadCounts(
      this.db,
      userId,
      moved.map((row) => row.conversationId),
    );
    await Promise.all(
      moved.map(({ conversationId, channel }) =>
        announceViewerEvent(this.realtime, {
          userIds: [userId],
          event: {
            type: channel ? "channel.marked.v1" : "dm.marked.v1",
            workspaceId,
            conversationId,
            unreadCount: counts.get(conversationId) ?? 0,
          },
        }),
      ),
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
   * read boundary up. Every online viewer re-reads this on each Workspace message, so it counts in
   * one statement rather than listing the items.
   */
  private async unreadTotal(workspaceId: string, userId: string): Promise<number> {
    const [{ unread }] = await this.db.$queryRaw<[{ unread: number }]>`
      SELECT ((
        SELECT COUNT(*) FROM ${conversationItemsSql(workspaceId, userId)}
        JOIN "messages" m
          ON m."conversationId" = cm."conversationId"
         AND m."threadRootId" IS NULL
         AND ${HUMAN_UNREAD_MESSAGE_SQL}
        WHERE ${conversationItemListedSql(userId)}
      ) + (
        SELECT COUNT(*) FROM ${threadItemsSql(workspaceId, userId)}
        JOIN "messages" m
          ON m."conversationId" = threads."conversationId"
         AND m."threadRootId" = threads."rootMessageId"
         AND ${unreadReplySql}
        WHERE ${threadItemListedSql(userId)}
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
    const [moved] = await this.db.$transaction([
      this.db.$queryRaw<{ conversationId: string; channel: boolean }[]>(
        markConversationsReadSql(workspaceId, userId, before),
      ),
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
    await this.announceMarked(workspaceId, userId, moved);
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
          c."directKey" AS "directKey",
          peer."agentId" AS "agentId",
          latest."id" AS "latestMessageId",
          latest."sequence" AS "latestSequence",
          latest."createdAt" AS "latestAt",
          unread."count" AS "unreadCount",
          unread."firstId" AS "firstUnreadMessageId",
          mention."unread" AS "unreadMention",
          mention."firstId" AS "firstMentionMessageId"
        FROM ${conversationItemsSql(workspaceId, userId)}
        ${conversationUnreadLateral}
        ${conversationMentionLateral}
        WHERE ${conversationItemListedSql(userId)}`,
      this.db.$queryRaw<ActivityCandidate[]>`
        SELECT
          threads."kind" AS "kind",
          threads."memberId" AS "memberId",
          threads."conversationId" AS "conversationId",
          threads."rootMessageId" AS "rootMessageId",
          c."channelName" AS "channelName",
          c."directKey" AS "directKey",
          peer."agentId" AS "agentId",
          latest."id" AS "latestMessageId",
          latest."sequence" AS "latestSequence",
          latest."createdAt" AS "latestAt",
          replies."unread" AS "unreadCount",
          replies."firstUnreadId" AS "firstUnreadMessageId",
          mention."unread" AS "unreadMention",
          mention."firstId" AS "firstMentionMessageId"
        FROM ${threadItemsSql(workspaceId, userId)}
        ${threadUnreadLateral}
        ${threadMentionLateral}
        WHERE ${threadItemListedSql(userId)}`,
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
      directKey: null,
      agentId: null,
      latestMessageId: row.messageId,
      latestSequence: row.message.sequence,
      latestAt: row.notifiedAt!,
      unreadCount: row.targetReadAt ? 0 : 1,
      firstUnreadMessageId: row.targetReadAt ? null : row.messageId,
      unreadMention: !row.targetReadAt,
      firstMentionMessageId: row.messageId,
      mentionAction: { resolutionId: row.id, threadRootId: row.message.threadRootId },
    }));
  }

  /** Loads the messages, DM peers (Agents and members), tasks and thread reply totals one page of
   * items renders, in one query each. */
  private async hydrate(workspaceId: string, userId: string, page: readonly ActivityCandidate[]) {
    const messageIds = new Set<string>();
    const agentIds = new Set<string>();
    // The member on the other side of each DM between people (the viewer, in their own), by key.
    const peerUserIds = new Map<string, string>();
    const rootIds: string[] = [];
    for (const candidate of page) {
      messageIds.add(candidate.latestMessageId);
      if (candidate.rootMessageId) {
        messageIds.add(candidate.rootMessageId);
        rootIds.push(candidate.rootMessageId);
      }
      if (candidate.agentId) agentIds.add(candidate.agentId);
      const peerUserId = peopleDirectPeerId(candidate.directKey, userId);
      if (peerUserId) peerUserIds.set(candidate.conversationId, peerUserId);
    }
    const [messages, agents, people, tasks, replyCounts] = await Promise.all([
      this.db.message.findMany({
        where: { id: { in: [...messageIds] }, workspaceId },
        select: browserMessageFields,
      }),
      this.db.agent.findMany({
        where: { id: { in: [...agentIds] }, workspaceId },
        select: { id: true, name: true, displayName: true, avatarObjectKey: true },
      }),
      // By the key, not a membership: the member stays named after leaving the Workspace.
      this.db.user.findMany({
        where: { id: { in: [...new Set(peerUserIds.values())] } },
        select: peoplePeerUserFields,
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
    ]);
    const replyCountByRoot = new Map(replyCounts.map((row) => [row.threadRootId, row._count._all]));
    const messageById = new Map(
      messages.map((message) => [message.id, mapBrowserMessage(message, workspaceId)]),
    );
    const agentById = new Map(
      agents.map((agent) => [
        agent.id,
        {
          kind: "agent" as const,
          agentId: agent.id,
          displayName: agent.displayName.trim() || agent.name,
          avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
        },
      ]),
    );
    const personById = new Map(
      people.map((person) => [person.id, peoplePeer(workspaceId, person)]),
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
      const latest = messageById.get(candidate.latestMessageId);
      const peerUserId = peerUserIds.get(candidate.conversationId);
      const peer = peerUserId
        ? personById.get(peerUserId)
        : candidate.agentId
          ? agentById.get(candidate.agentId)
          : undefined;
      const place =
        candidate.kind === "channel"
          ? {
              kind: "channel" as const,
              conversationId: candidate.conversationId,
              channelName: candidate.channelName ?? "",
            }
          : peer
            ? { kind: "direct" as const, conversationId: candidate.conversationId, peer }
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
          unreadCount: candidate.unreadCount,
          firstUnreadMessageId: candidate.firstUnreadMessageId,
          unreadMention: candidate.unreadMention,
          firstMentionMessageId: candidate.firstMentionMessageId,
          mentionAction: candidate.mentionAction ?? null,
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

/**
 * The per-candidate unread and mention laterals. Each names the aliases its `FROM` provides (`cm`
 * for conversations, `threads`/`tr` for threads).
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
  SELECT COALESCE(BOOL_OR(${HUMAN_UNREAD_MESSAGE_SQL}), FALSE) AS "unread",
    (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
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
  SELECT COALESCE(BOOL_OR(${unreadReplySql}), FALSE) AS "unread",
    (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
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
 * The viewer's joined conversations with a DM's Agent (`peer`) and newest top-level message
 * (`latest`), as the `FROM` of an item query over `cm` and `c`. `conversationItemListedSql` is
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

/**
 * A joined conversation is listed when it is a channel or one of the viewer's own DMs (the ones
 * their Direct messages list holds), with activity past Done.
 */
function conversationItemListedSql(userId: string) {
  return Prisma.sql`(c."channelName" IS NOT NULL OR ${viewerDirectConversationSql(userId)})
    AND latest."sequence" > COALESCE(cm."doneThroughSequence", 0)`;
}

/**
 * The viewer's followed channel threads and direct-message threads (`threads`) with their
 * conversation (`c`), a DM's Agent (`peer`), thread cursors (`tr`) and newest reply (`latest`), as
 * the `FROM` of an item query. `threadItemListedSql` is its `WHERE`.
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

/** A thread is listed with a reply past Done; a direct-message thread only in the viewer's own DMs. */
function threadItemListedSql(userId: string) {
  return Prisma.sql`latest."sequence" > COALESCE(tr."doneThroughSequence", 0)
    AND (threads."kind" = 'channel' OR ${viewerDirectConversationSql(userId)})`;
}
