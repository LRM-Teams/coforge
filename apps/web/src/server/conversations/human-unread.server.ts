import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";

/**
 * A person's unread rule, their read and Done cursor writes, and where marking unread anchors,
 * shared by the Chat sidebar badges (`PublicChannels.list`, the direct-conversation repository),
 * the mark-as-unread writers and the Activity inbox, so the surfaces cannot drift apart.
 *
 * Unread means someone else's message past the person's cursor: their own messages and system
 * notices (no sender member) never count. Every cursor write only moves forward.
 */

/**
 * A top-level message `m` unread for the member row `cm`: someone else's message past the read
 * cursor, or at or past the mark-as-unread marker. Written as one lower bound (`LEAST` ignores a
 * NULL marker, leaving the read cursor) so a per-conversation count is an index range on
 * `messages(conversationId, sequence)` over the unread tail, not a scan of every message.
 */
export const HUMAN_UNREAD_MESSAGE_SQL = Prisma.sql`m."sequence" > LEAST(cm."readThroughSequence", cm."unreadFromSequence" - 1)
  AND m."senderMemberId" IS NOT NULL
  AND m."senderMemberId" <> cm."id"`;

/** Where a person stands in one of their conversations: how many of its top-level messages are
 * unread for them (the badge, by the same rule `PublicChannels.list` counts every row's with), and
 * their read cursor (`readThroughSequence`), which a page's stored window draws its divider from. */
export type HumanReadState = { unreadCount: number; readThroughSequence: number };

/** `HumanReadState` of one conversation the person `userId` is in; nothing unread and nothing read
 * when they are not in it. */
export async function humanReadState(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  conversationId: string,
  userId: string,
): Promise<HumanReadState> {
  return (
    (await humanReadStates(db, userId, [conversationId])).get(conversationId) ?? {
      unreadCount: 0,
      readThroughSequence: 0,
    }
  );
}

/** `humanReadState` for several of the person's conversations in one read, by conversation id;
 * a conversation they are not in has no entry. */
export async function humanReadStates(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  conversationIds: readonly string[],
): Promise<Map<string, HumanReadState>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    { conversationId: string; count: number; readThroughSequence: number }[]
  >`
    SELECT cm."conversationId" AS "conversationId", unread."count" AS "count",
      cm."readThroughSequence" AS "readThroughSequence"
    FROM "conversation_members" cm
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS "count"
      FROM "messages" m
      WHERE m."conversationId" = cm."conversationId"
        AND m."threadRootId" IS NULL
        AND ${HUMAN_UNREAD_MESSAGE_SQL}
    ) unread
    WHERE cm."userId" = ${userId}::uuid
      AND cm."conversationId" = ANY(${[...conversationIds]}::uuid[])
      AND cm."leftAt" IS NULL`;
  return new Map(
    rows.map((row) => [
      row.conversationId,
      { unreadCount: row.count, readThroughSequence: row.readThroughSequence },
    ]),
  );
}

/**
 * Advances the person's top-level read cursor in a channel or DM they are in: monotone and clamped
 * to the conversation's newest message, so a stale client cannot move it back nor push it past the
 * conversation. Reading past a mark-as-unread marker consumes it. Returns where the move left the
 * person (`HumanReadState`; nothing unread when it read through the newest message, else counted
 * after the commit), or undefined when nothing moved, so a caller announces only real moves.
 */
export async function markHumanRead(
  db: PrismaClient,
  read: { conversationId: string; userId: string; throughSequence: number },
): Promise<HumanReadState | undefined> {
  const { conversationId, userId } = read;
  const moved = await db.$transaction(async (tx) => {
    const latest = await tx.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const boundary = Math.min(read.throughSequence, latest?.sequence ?? 0);
    if (boundary < 1) return undefined;
    const advanced = await tx.conversationMember.updateMany({
      where: {
        conversationId,
        userId,
        readThroughSequence: { lt: boundary },
        ...ACTIVE_MEMBER_WHERE,
      },
      data: { readThroughSequence: boundary },
    });
    // Reading past the forced `mark as unread` marker consumes it, so the badge does not come
    // back on the next render (see the marker's note in the schema).
    const consumed = await tx.conversationMember.updateMany({
      where: {
        conversationId,
        userId,
        unreadFromSequence: { not: null, lte: boundary },
        ...ACTIVE_MEMBER_WHERE,
      },
      data: { unreadFromSequence: null },
    });
    if (advanced.count === 0 && consumed.count === 0) return undefined;
    return { throughLatest: boundary === latest?.sequence, boundary };
  });
  if (!moved) return undefined;
  // Through the newest message the cursor is at it, whether this read moved it or an earlier one.
  if (moved.throughLatest) return { unreadCount: 0, readThroughSequence: moved.boundary };
  return humanReadState(db, conversationId, userId);
}

/**
 * Where marking a conversation unread puts the marker for the member row `memberId`: the newest
 * top-level message someone else sent, so the badge it opens counts at least one. Null when there
 * is none, since the person's own messages and system notices never count (the same sender rule
 * as `HUMAN_UNREAD_MESSAGE_SQL`).
 */
export async function markUnreadAnchor(
  tx: Prisma.TransactionClient,
  conversationId: string,
  memberId: string,
) {
  const newest = await tx.message.findFirst({
    where: {
      conversationId,
      threadRootId: null,
      NOT: [{ senderMemberId: null }, { senderMemberId: memberId }],
    },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return newest?.sequence ?? null;
}

/** A thread reply `m` unread for `memberId`, whose thread cursor is `readThrough` (null when
 * the thread was never read). */
export function humanUnreadReplySql(memberId: Prisma.Sql, readThrough: Prisma.Sql) {
  return Prisma.sql`m."senderMemberId" IS NOT NULL
    AND m."senderMemberId" IS DISTINCT FROM ${memberId}
    AND m."sequence" > COALESCE(${readThrough}, 0)`;
}

/**
 * Marks one member row's conversation Done through `boundary` and reads it through the same
 * message, consuming a mark-as-unread marker at or below it.
 */
export function markConversationDoneSql(memberId: string, boundary: number) {
  return Prisma.sql`
    UPDATE "conversation_members"
    SET "readThroughSequence" = GREATEST("readThroughSequence", ${boundary}),
        "unreadFromSequence" = CASE
          WHEN "unreadFromSequence" <= ${boundary} THEN NULL ELSE "unreadFromSequence" END,
        "doneThroughSequence" = GREATEST(COALESCE("doneThroughSequence", 0), ${boundary})
    WHERE "id" = ${memberId}::uuid`;
}

/** Marks one member's thread Done through `boundary` and reads it through the same reply. */
export function markThreadDoneSql(
  thread: { memberId: string; conversationId: string; workspaceId: string; rootMessageId: string },
  boundary: number,
) {
  return Prisma.sql`
    INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence",
       "doneThroughSequence")
    VALUES (${thread.memberId}::uuid, ${thread.conversationId}::uuid,
      ${thread.workspaceId}::uuid, ${thread.rootMessageId}::uuid, ${boundary}, ${boundary})
    ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET
      "readThroughSequence" = GREATEST("thread_reads"."readThroughSequence", ${boundary}),
      "doneThroughSequence" =
        GREATEST(COALESCE("thread_reads"."doneThroughSequence", 0), ${boundary})`;
}

/**
 * Reads every conversation one person belongs to through its newest top-level message posted at
 * or before `before`, consuming mark-as-unread markers at or below that point. Touches only the
 * rows that move, and returns each one's conversation and whether it is a channel.
 */
export function markConversationsReadSql(workspaceId: string, userId: string, before: Date) {
  return Prisma.sql`
    UPDATE "conversation_members" cm
    SET "readThroughSequence" = GREATEST(cm."readThroughSequence", latest."sequence"),
        "unreadFromSequence" = CASE
          WHEN cm."unreadFromSequence" <= latest."sequence" THEN NULL
          ELSE cm."unreadFromSequence" END
    FROM "conversations" c
    CROSS JOIN LATERAL (
      SELECT m."sequence" FROM "messages" m
      WHERE m."conversationId" = c."id" AND m."threadRootId" IS NULL AND m."createdAt" <= ${before}
      ORDER BY m."sequence" DESC LIMIT 1
    ) latest
    WHERE c."id" = cm."conversationId"
      AND c."workspaceId" = ${workspaceId}::uuid
      AND cm."userId" = ${userId}::uuid
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND cm."leftAt" IS NULL
      AND (cm."readThroughSequence" < latest."sequence"
        OR cm."unreadFromSequence" <= latest."sequence")
    RETURNING cm."conversationId" AS "conversationId", c."channelName" IS NOT NULL AS "channel"`;
}

/**
 * Reads threads through their newest reply posted at or before `before`. `threads` selects
 * `"memberId"`, `"conversationId"` and `"rootMessageId"` rows for the person's own member rows.
 */
export function markThreadsReadSql(workspaceId: string, threads: Prisma.Sql, before: Date) {
  return Prisma.sql`
    INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
    SELECT threads."memberId", threads."conversationId", ${workspaceId}::uuid,
      threads."rootMessageId", latest."sequence"
    FROM (${threads}) threads
    CROSS JOIN LATERAL (
      SELECT m."sequence" FROM "messages" m
      WHERE m."conversationId" = threads."conversationId"
        AND m."threadRootId" = threads."rootMessageId"
        AND m."createdAt" <= ${before}
      ORDER BY m."sequence" DESC LIMIT 1
    ) latest
    ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
      GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`;
}

/** The channel threads one person follows, as `markThreadsReadSql` rows. */
export function followedChannelThreadsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT cm."id" AS "memberId", cm."conversationId", tf."rootMessageId"
    FROM "thread_follows" tf
    JOIN "conversation_members" cm ON cm."id" = tf."memberId"
    JOIN "conversations" c
      ON c."id" = cm."conversationId" AND c."channelName" IS NOT NULL AND c."archivedAt" IS NULL
     AND c."hiddenFromWorkspaceAt" IS NULL
    WHERE cm."userId" = ${userId}::uuid
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND cm."leftAt" IS NULL`;
}

/**
 * Every thread in one person's direct messages, as `markThreadsReadSql` rows. A direct message
 * has no follow switch: every thread in it is theirs.
 */
export function directThreadsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT cm."id" AS "memberId", cm."conversationId", roots."rootMessageId"
    FROM "conversation_members" cm
    JOIN "conversations" c ON c."id" = cm."conversationId" AND c."directKey" IS NOT NULL
    CROSS JOIN LATERAL (
      SELECT DISTINCT r."threadRootId" AS "rootMessageId" FROM "messages" r
      WHERE r."conversationId" = cm."conversationId" AND r."threadRootId" IS NOT NULL
    ) roots
    WHERE cm."userId" = ${userId}::uuid
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND cm."leftAt" IS NULL`;
}
