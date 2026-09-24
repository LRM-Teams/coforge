import { Prisma } from "#src/generated/prisma/client";

/**
 * A person's unread rule and their read and Done cursor writes, as SQL shared by the Chat sidebar
 * badges (`PublicChannels.list`, the direct-conversation repository) and the Activity inbox, so
 * the surfaces cannot drift apart.
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
 * or before `before`, consuming mark-as-unread markers at or below that point.
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
      AND cm."leftAt" IS NULL`;
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
