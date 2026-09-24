import { Prisma, type PrismaClient } from "#src/generated/prisma/client";

export type MessageSearchSort = "relevance" | "recent";

export type MessageSearchCriteria = {
  workspaceId: string;
  /** The human searching; only conversations they may read are searched. */
  viewerUserId: string;
  /** Whitespace-separated terms; every term must appear in the body. Empty: no text match. */
  terms: string[];
  /** The raw query `relevance` ranks against. */
  query: string;
  /** A sender's user or Agent id. */
  senderId?: string;
  senderKind?: "user" | "agent";
  mentionsViewer?: boolean;
  conversationId?: string;
  after?: Date;
  before?: Date;
  sort: MessageSearchSort;
  limit: number;
  offset: number;
};

/** `ILIKE` treats `\`, `%` and `_` as syntax; escape them so every term matches literally. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Ids of the messages matching a search, in result order, one row past `limit` so the caller
 * can tell whether another page exists.
 *
 * Raw SQL because ranking uses `pg_trgm`, which Prisma cannot express: `word_similarity` scores
 * how closely some stretch of the body matches the query, and `similarity` breaks its ties in
 * favour of bodies where the query makes up more of the text (short, focused messages). The
 * body match is `ILIKE`, which the trigram GIN index `messages_body_idx` serves for terms of
 * three or more characters; shorter terms scan the Workspace's messages.
 *
 * A human may read every channel in the Workspace (joined, left or never joined, archived too)
 * and only the direct conversations they belong to, the same rule `ConversationHistory.authorize`
 * applies to a single conversation. System rows have no sender and are never results.
 */
export async function findMessageSearchIds(
  db: PrismaClient,
  criteria: MessageSearchCriteria,
): Promise<string[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`m."workspaceId" = ${criteria.workspaceId}::uuid`,
    // A channel hidden from the Workspace is searched by nobody.
    Prisma.sql`c."hiddenFromWorkspaceAt" IS NULL`,
    Prisma.sql`(c."channelName" IS NOT NULL OR c."directKey" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "conversation_members" v
      WHERE v."conversationId" = c."id" AND v."userId" = ${criteria.viewerUserId}::uuid))`,
    ...criteria.terms.map((term) => Prisma.sql`m."body" ILIKE ${containsPattern(term)}`),
  ];
  if (criteria.senderId) {
    conditions.push(
      Prisma.sql`(s."userId" = ${criteria.senderId}::uuid OR s."agentId" = ${criteria.senderId}::uuid)`,
    );
  }
  if (criteria.senderKind === "user") conditions.push(Prisma.sql`s."userId" IS NOT NULL`);
  if (criteria.senderKind === "agent") conditions.push(Prisma.sql`s."agentId" IS NOT NULL`);
  if (criteria.mentionsViewer) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "message_mentions" mm
      WHERE mm."messageId" = m."id" AND mm."kind" = 'user'
        AND mm."actorId" = ${criteria.viewerUserId}::uuid)`);
  }
  if (criteria.conversationId) {
    conditions.push(Prisma.sql`m."conversationId" = ${criteria.conversationId}::uuid`);
  }
  if (criteria.after) conditions.push(Prisma.sql`m."createdAt" >= ${criteria.after}`);
  if (criteria.before) conditions.push(Prisma.sql`m."createdAt" < ${criteria.before}`);

  const order =
    criteria.sort === "relevance" && criteria.terms.length > 0
      ? Prisma.sql`word_similarity(${criteria.query}, m."body") DESC,
          similarity(${criteria.query}, m."body") DESC, m."createdAt" DESC, m."id" DESC`
      : Prisma.sql`m."createdAt" DESC, m."id" DESC`;

  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT m."id"
    FROM "messages" m
    JOIN "conversations" c ON c."id" = m."conversationId"
    JOIN "conversation_members" s ON s."id" = m."senderMemberId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY ${order}
    LIMIT ${criteria.limit + 1} OFFSET ${criteria.offset}`;
  return rows.map((row) => row.id);
}
