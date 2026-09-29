import type { PrismaClient } from "#src/generated/prisma/client";
import {
  THREAD_PREVIEW_REPLIES,
  previewBody,
  type ThreadSummary,
} from "#src/features/conversations/thread-summary-model";
import { browserSenderAvatarUrl, browserSenderName } from "./sender-display.server";

/** What a window of roots says about their threads, for the viewer reading it. */
export type WindowThreads = {
  /** A summary per root that has replies. */
  threads: Record<string, ThreadSummary>;
  /** The viewer's thread read cursors, for these roots only. */
  threadReadThrough: Record<string, number>;
};

type SummaryRow = {
  rootId: string;
  replyCount: number;
  lastReplySequence: number;
  lastReplyAt: Date;
  unread: number;
};

/**
 * The thread summaries and the viewer's read cursors for the roots one window holds: one
 * aggregate over their replies, one read of each thread's newest few, and the viewer's own cursor
 * rows, all served by `messages(conversationId, threadRootId, sequence)` and the primary key of
 * `thread_reads`. Replies themselves stay behind (`ConversationHistory.loadThread` reads a whole
 * thread).
 *
 * `unread` counts the Agents' replies past the viewer's cursor (every one for a thread never
 * read); the stream's thread badge has always meant that, unlike the Activity inbox's rule
 * (`humanUnreadReplySql`). `viewerMemberId` is absent for someone who never joined or has left:
 * nothing is unread for them, and they keep no cursors.
 */
export async function readWindowThreads(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    rootIds: readonly string[];
    viewerMemberId?: string;
  },
): Promise<WindowThreads> {
  const { workspaceId, conversationId, rootIds, viewerMemberId } = input;
  if (rootIds.length === 0) return { threads: {}, threadReadThrough: {} };
  const roots = [...rootIds];
  const [rows, previewIds, reads] = await Promise.all([
    db.$queryRaw<SummaryRow[]>`
      WITH viewer_reads AS (
        SELECT "rootMessageId", "readThroughSequence" FROM "thread_reads"
        WHERE "memberId" = ${viewerMemberId ?? null}::uuid AND "rootMessageId" = ANY(${roots}::uuid[])
      )
      SELECT
        m."threadRootId" AS "rootId",
        COUNT(*) FILTER (WHERE m."senderMemberId" IS NOT NULL)::int AS "replyCount",
        MAX(m."sequence")::int AS "lastReplySequence",
        MAX(m."createdAt") AS "lastReplyAt",
        COUNT(*) FILTER (
          WHERE sender."agentId" IS NOT NULL
            AND m."sequence" > COALESCE(viewer_reads."readThroughSequence", 0)
        )::int AS "unread"
      FROM "messages" m
      LEFT JOIN "conversation_members" sender ON sender."id" = m."senderMemberId"
      LEFT JOIN viewer_reads ON viewer_reads."rootMessageId" = m."threadRootId"
      WHERE m."conversationId" = ${conversationId}::uuid
        AND m."threadRootId" = ANY(${roots}::uuid[])
      GROUP BY m."threadRootId"`,
    db.$queryRaw<{ id: string }[]>`
      SELECT newest."id" AS "id"
      FROM unnest(${roots}::uuid[]) AS root("id")
      CROSS JOIN LATERAL (
        SELECT m."id" FROM "messages" m
        WHERE m."conversationId" = ${conversationId}::uuid
          AND m."threadRootId" = root."id"
          AND m."senderMemberId" IS NOT NULL
        ORDER BY m."sequence" DESC
        LIMIT ${THREAD_PREVIEW_REPLIES}
      ) newest`,
    viewerMemberId
      ? db.threadRead.findMany({
          where: { memberId: viewerMemberId, rootMessageId: { in: roots } },
          select: { rootMessageId: true, readThroughSequence: true },
        })
      : [],
  ]);
  const previews = previewIds.length
    ? await db.message.findMany({
        where: { id: { in: previewIds.map((row) => row.id) } },
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          threadRootId: true,
          body: true,
          createdAt: true,
          sender: {
            select: {
              userId: true,
              agentId: true,
              user: { select: { username: true, displayName: true, avatarObjectKey: true } },
              agent: {
                select: { name: true, displayName: true, deletedAt: true, avatarObjectKey: true },
              },
            },
          },
        },
      })
    : [];
  const latestByRoot = new Map<string, ThreadSummary["latestReplies"]>();
  for (const message of previews) {
    const list = latestByRoot.get(message.threadRootId!) ?? [];
    list.push({
      id: message.id,
      sequence: message.sequence,
      senderName: browserSenderName(message.sender),
      senderAvatarUrl: browserSenderAvatarUrl(message.sender, workspaceId),
      senderDeleted: Boolean(message.sender?.agent?.deletedAt),
      body: previewBody(message.body),
      createdAt: message.createdAt.toISOString(),
    });
    latestByRoot.set(message.threadRootId!, list);
  }
  const threads: Record<string, ThreadSummary> = {};
  const threadReadThrough = Object.fromEntries(
    reads.map((read) => [read.rootMessageId, read.readThroughSequence]),
  );
  for (const row of rows) {
    threads[row.rootId] = {
      replyCount: row.replyCount,
      lastReplySequence: row.lastReplySequence,
      lastReplyAt: row.lastReplyAt.toISOString(),
      unread: viewerMemberId ? row.unread : 0,
      latestReplies: latestByRoot.get(row.rootId) ?? [],
    };
  }
  return { threads, threadReadThrough };
}

/** The ids of the channel threads the viewer follows, among the roots one window holds. */
export async function followedThreadRootIds(
  db: PrismaClient,
  input: { viewerMemberId?: string; rootIds: readonly string[] },
): Promise<string[]> {
  if (!input.viewerMemberId || input.rootIds.length === 0) return [];
  const follows = await db.threadFollow.findMany({
    where: { memberId: input.viewerMemberId, rootMessageId: { in: [...input.rootIds] } },
    select: { rootMessageId: true },
  });
  return follows.map((follow) => follow.rootMessageId);
}
