import { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

/**
 * The direct conversations a viewer's Direct messages list holds, by `DirectConversations.authorize`'s
 * rule: one between members that names them, or their own DM with an Agent they created. A deleted
 * Agent's DM stays readable by its link but leaves the list. A pin drag reads exactly these.
 * `viewerDirectConversationSql` is the same rule for raw SQL; change the two together.
 */
export function viewerDirectConversationWhere(userId: string) {
  return {
    OR: [
      { directKey: { startsWith: "user:", contains: `user:${userId}` } },
      {
        directKey: { endsWith: `|user:${userId}` },
        members: { some: { agent: { ownerId: userId, ...ACTIVE_AGENT_WHERE } } },
      },
    ],
  } satisfies Prisma.ConversationWhereInput;
}

/**
 * `viewerDirectConversationWhere` as a raw SQL condition on a `"conversations"` row aliased `c`,
 * for the Activity inbox's item queries: the same two branches, clause for clause. Ids are UUIDs,
 * so the `LIKE` patterns hold no wildcard of their own.
 */
export function viewerDirectConversationSql(userId: string) {
  return Prisma.sql`(
    (c."directKey" LIKE 'user:%' AND c."directKey" LIKE ${`%user:${userId}%`})
    OR (
      c."directKey" LIKE ${`%|user:${userId}`}
      AND EXISTS (
        SELECT 1 FROM "conversation_members" own
        JOIN "agents" a ON a."id" = own."agentId"
        WHERE own."conversationId" = c."id"
          AND a."ownerId" = ${userId}::uuid
          AND a."deletedAt" IS NULL
      )
    )
  )`;
}
