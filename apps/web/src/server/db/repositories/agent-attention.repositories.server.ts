import { Prisma } from "#src/generated/prisma/client";

/**
 * An Agent's attention rule: which messages it still owes attention to, as the Prisma filters and
 * the SQL that the direct-conversation repository's recovery, drain, pending-context and delivery
 * reads share, so those reads cannot drift apart. The human counterpart is
 * `server/conversations/human-unread.server.ts`.
 */

/** A mention whose target is this Agent, which the sender had it notified of. */
export const NOTIFIED_AGENT_WHERE = (agentId: string) =>
  ({
    targetAgentId: agentId,
    notifiedAt: { not: null },
  }) satisfies Prisma.PendingMentionActionWhereInput;

/**
 * Messages an Agent has not yet consumed: from a user, or delivered explicitly to it — and in a
 * channel *only* when delivered, because a channel message the Agent was not addressed by is not
 * its attention to owe. The clause is not redundant with the `OR`: `(human ∨ delivered)` narrowed
 * by `delivered` is exactly `delivered`, so it is what keeps the channel case strict while the
 * direct case stays permissive (a DM's Agent-authored handoff carries a delivery row).
 */
function unreadForAgentWhere(agentId: string, isChannel: boolean) {
  return {
    OR: [{ sender: { userId: { not: null } } }, { deliveries: { some: { agentId } } }],
    ...(isChannel ? { deliveries: { some: { agentId } } } : {}),
  } satisfies Prisma.MessageWhereInput;
}

/** One target an Agent owes attention in: above `afterSequence`, and never `excludeSenderMemberId`'s. */
export type AgentAttentionScope = {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  isChannel: boolean;
  afterSequence?: number;
  excludeSenderMemberId?: string;
};

export function agentAttentionMessageWhere(scope: AgentAttentionScope) {
  return {
    conversationId: scope.conversationId,
    threadRootId: scope.threadRootId,
    ...(scope.afterSequence !== undefined ? { sequence: { gt: scope.afterSequence } } : {}),
    ...(scope.excludeSenderMemberId
      ? { senderMemberId: { not: scope.excludeSenderMemberId } }
      : {}),
    ...unreadForAgentWhere(scope.agentId, scope.isChannel),
  } satisfies Prisma.MessageWhereInput;
}

/**
 * Whether a target's attention is read from the Agent's delivery rows (a channel's top level)
 * rather than from the target's own messages (a thread, or a direct message).
 */
export function readsAgentDeliveries(scope: AgentAttentionScope) {
  return scope.isChannel && scope.threadRootId === null;
}

/**
 * The same scope as `agentAttentionMessageWhere` for a channel's top level, as the Agent's delivery
 * rows (see `readsAgentDeliveries`).
 */
export function agentAttentionDeliveryWhere(scope: AgentAttentionScope) {
  return {
    agentId: scope.agentId,
    conversationId: scope.conversationId,
    ...(scope.afterSequence !== undefined ? { sequence: { gt: scope.afterSequence } } : {}),
    message: {
      threadRootId: null,
      ...(scope.excludeSenderMemberId
        ? { senderMemberId: { not: scope.excludeSenderMemberId } }
        : {}),
    },
  } satisfies Prisma.AgentMessageDeliveryWhereInput;
}

/**
 * Messages the Agent owes attention to: above its per-target read boundary, from a user, or
 * explicitly delivered to it; channels only count with a delivery row. Shared by
 * `readAgentRecoveryContext` and `drainAgentEvents` so the rule cannot drift between them.
 *
 * `senderAgentName`/`senderAgentDescription` and `senderUsername`/`senderUserDescription` carry
 * the message's own author (an Agent, else a human) as separate columns rather than one merged
 * name, so the caller can tell which kind it is and attach its description; a raw SQL
 * statement cannot call the shared `agentMessageSender` projection directly. `otherUsername` is
 * the *recipient* — the conversation's other active member, which a DM target needs and a
 * message's sender cannot supply.
 *
 * The `m` subquery narrows the scan before the rule is applied, one disjoint branch per
 * conversation kind and level: a channel message only counts with a delivery row, so a channel's
 * top level is an index range over the Agent's deliveries above its boundary, and a direct
 * message's top level is an index range over the history above it. Only thread replies, whose
 * boundary is per thread, are scanned in full. The outer `WHERE` still states the whole rule.
 */
export function unreadAgentMessagesFragment(
  workspaceId: string,
  agentId: string,
  scope?: { conversationId: string; threadRootId: string | null },
) {
  const targetFilter = !scope
    ? Prisma.empty
    : scope.threadRootId
      ? Prisma.sql` AND m."conversationId" = ${scope.conversationId}::uuid AND m."threadRootId" = ${scope.threadRootId}::uuid`
      : Prisma.sql` AND m."conversationId" = ${scope.conversationId}::uuid AND m."threadRootId" IS NULL`;
  // A channel delivery already read while the Agent was notified from outside the channel is not
  // read again as a member.
  const notReadAsNonMember = Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "pending_mention_actions" rpma
    WHERE rpma."messageId" = cd."messageId" AND rpma."targetAgentId" = ${agentId}::uuid
      AND rpma."targetReadAt" IS NOT NULL
  )`;
  return Prisma.sql`
    SELECT m."id", m."sequence", m."body", m."conversationId", m."threadRootId",
      m."senderMemberId", COALESCE(r."sequence", 0) AS "rootSequence",
      d."deliveryId", (am."id" IS NULL) AS "nonMemberMention",
      sa."name" AS "senderAgentName", sa."description" AS "senderAgentDescription",
      su."username" AS "senderUsername", su."description" AS "senderUserDescription",
      c."channelName",
      (SELECT COALESCE(ou."username", oa."name")
        FROM "conversation_members" om
        LEFT JOIN "users" ou ON ou."id" = om."userId"
        LEFT JOIN "agents" oa ON oa."id" = om."agentId"
        WHERE om."conversationId" = c."id" AND om."id" <> am."id" AND om."leftAt" IS NULL
        ORDER BY ou."username" NULLS LAST LIMIT 1) AS "otherUsername"
    FROM (
      SELECT cm."id", cm."sequence", cm."body", cm."conversationId", cm."threadRootId",
        cm."senderMemberId"
      FROM "conversation_members" cam
      JOIN "conversations" cc ON cc."id" = cam."conversationId" AND cc."channelName" IS NOT NULL
        AND cc."hiddenFromWorkspaceAt" IS NULL
      -- Each membership reads its own index range above the Agent's boundary; a delivery carries
      -- its message's sequence. OFFSET 0 is an optimization fence: without it PostgreSQL flattens
      -- the subquery and, unable to estimate a bound taken from another row, joins every
      -- delivery the Agent has ever received.
      CROSS JOIN LATERAL (
        SELECT d."messageId" FROM "agent_message_deliveries" d
        WHERE d."agentId" = cam."agentId" AND d."conversationId" = cam."conversationId"
          AND d."sequence" > cam."agentReadThroughSequence"
        OFFSET 0
      ) cd
      JOIN "messages" cm ON cm."id" = cd."messageId" AND cm."threadRootId" IS NULL
      WHERE cam."workspaceId" = ${workspaceId}::uuid AND cam."agentId" = ${agentId}::uuid
        AND cam."leftAt" IS NULL AND ${notReadAsNonMember}
      UNION ALL
      SELECT cm."id", cm."sequence", cm."body", cm."conversationId", cm."threadRootId",
        cm."senderMemberId"
      FROM "conversation_members" cam
      JOIN "conversations" cc ON cc."id" = cam."conversationId" AND cc."channelName" IS NOT NULL
        AND cc."hiddenFromWorkspaceAt" IS NULL
      -- Starts from the channel's thread replies and joins each reply's delivery: starting from
      -- the Agent's deliveries would walk its whole channel history again.
      JOIN "messages" cm ON cm."conversationId" = cam."conversationId"
        AND cm."threadRootId" IS NOT NULL
      JOIN "agent_message_deliveries" cd ON cd."messageId" = cm."id" AND cd."agentId" = cam."agentId"
      LEFT JOIN "thread_reads" ctr
        ON ctr."memberId" = cam."id" AND ctr."rootMessageId" = cm."threadRootId"
      WHERE cam."workspaceId" = ${workspaceId}::uuid AND cam."agentId" = ${agentId}::uuid
        AND cam."leftAt" IS NULL AND cm."sequence" > COALESCE(ctr."readThroughSequence", 0)
        AND ${notReadAsNonMember}
      UNION ALL
      SELECT dm."id", dm."sequence", dm."body", dm."conversationId", dm."threadRootId",
        dm."senderMemberId"
      FROM "conversation_members" dam
      JOIN "conversations" dc ON dc."id" = dam."conversationId" AND dc."channelName" IS NULL
      JOIN "messages" dm ON dm."conversationId" = dam."conversationId"
        AND dm."threadRootId" IS NULL AND dm."sequence" > dam."agentReadThroughSequence"
      WHERE dam."workspaceId" = ${workspaceId}::uuid AND dam."agentId" = ${agentId}::uuid
        AND dam."leftAt" IS NULL
      UNION ALL
      SELECT dm."id", dm."sequence", dm."body", dm."conversationId", dm."threadRootId",
        dm."senderMemberId"
      FROM "conversation_members" dam
      JOIN "conversations" dc ON dc."id" = dam."conversationId" AND dc."channelName" IS NULL
      JOIN "messages" dm ON dm."conversationId" = dam."conversationId"
        AND dm."threadRootId" IS NOT NULL
      LEFT JOIN "thread_reads" dtr
        ON dtr."memberId" = dam."id" AND dtr."rootMessageId" = dm."threadRootId"
      WHERE dam."workspaceId" = ${workspaceId}::uuid AND dam."agentId" = ${agentId}::uuid
        AND dam."leftAt" IS NULL AND dm."sequence" > COALESCE(dtr."readThroughSequence", 0)
      UNION ALL
      -- A channel message the Agent was notified of without being a member: unread until it is
      -- read once. A member reads it through its channel branch above instead.
      SELECT nm."id", nm."sequence", nm."body", nm."conversationId", nm."threadRootId",
        nm."senderMemberId"
      FROM "pending_mention_actions" pma
      JOIN "messages" nm ON nm."id" = pma."messageId"
      JOIN "conversations" nc ON nc."id" = nm."conversationId" AND nc."hiddenFromWorkspaceAt" IS NULL
      WHERE pma."workspaceId" = ${workspaceId}::uuid AND pma."targetAgentId" = ${agentId}::uuid
        AND pma."notifiedAt" IS NOT NULL AND pma."targetReadAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "conversation_members" nam
          WHERE nam."conversationId" = nm."conversationId" AND nam."agentId" = ${agentId}::uuid
            AND nam."leftAt" IS NULL
        )
    ) m
    LEFT JOIN "conversation_members" am ON am."conversationId" = m."conversationId"
      AND am."workspaceId" = ${workspaceId}::uuid AND am."agentId" = ${agentId}::uuid
      AND am."leftAt" IS NULL
    JOIN "conversations" c ON c."id" = m."conversationId"
    LEFT JOIN "messages" r ON r."id" = m."threadRootId"
    LEFT JOIN "thread_reads" tr ON tr."memberId" = am."id" AND tr."rootMessageId" = m."threadRootId"
    LEFT JOIN "conversation_members" sm ON sm."id" = m."senderMemberId"
    LEFT JOIN "users" su ON su."id" = sm."userId"
    LEFT JOIN "agents" sa ON sa."id" = sm."agentId"
    LEFT JOIN "agent_message_deliveries" d ON d."messageId" = m."id" AND d."agentId" = ${agentId}::uuid
    WHERE (am."id" IS NULL OR m."sequence" > CASE WHEN m."threadRootId" IS NULL
        THEN am."agentReadThroughSequence" ELSE COALESCE(tr."readThroughSequence", 0) END)
      AND (sm."userId" IS NOT NULL OR d."deliveryId" IS NOT NULL)
      AND (c."channelName" IS NULL OR d."deliveryId" IS NOT NULL)
      ${targetFilter}`;
}
