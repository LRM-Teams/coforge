import { Prisma } from "#src/generated/prisma/client";

/**
 * An Agent's attention rule: which messages it still owes attention to, as the Prisma filters and
 * the SQL that the direct-conversation repository's recovery, drain, pending-context and delivery
 * reads share, so those reads cannot drift apart. The raw SQL names the tables and columns Prisma
 * maps the models to (`@@map`), which a migration must keep in step. The human counterpart is
 * `server/conversations/human-unread.server.ts`.
 */

/** A mention whose target is this Agent, which the sender had it notified of. */
export const NOTIFIED_AGENT_WHERE = (agentId: string) =>
  ({
    targetAgentId: agentId,
    notifiedAt: { not: null },
  }) satisfies Prisma.PendingMentionActionWhereInput;

/**
 * One target an Agent owes attention in: above `afterSequence` (no bound when absent), less
 * `excludeSequences` (the messages the Agent reported it was shown one by one, Raft 1.0.38's
 * `seenExactSeqs`), and never the Agent's own messages (`ownMemberId`; Raft's `isMessageModelSeen`
 * counts them as seen).
 */
export type AgentAttentionScope = {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  isChannel: boolean;
  afterSequence?: number;
  excludeSequences?: readonly number[];
  ownMemberId?: string;
};

/**
 * The messages of one target the Agent owes attention to, as the `FROM … WHERE` of a statement
 * whose rows are `m`. A message counts when a user sent it or it was delivered to the Agent, and in
 * a channel only when delivered: a channel message the Agent was not addressed by is not its
 * attention to owe (`(human ∨ delivered) ∧ delivered` is exactly `delivered`, which keeps the
 * channel case strict while a DM's Agent-authored handoff still counts through its delivery row).
 *
 * A channel's top level reads the Agent's delivery rows (`agentId, conversationId, sequence`
 * index) instead of walking the channel's history and probing every message for a delivery. A
 * thread and a direct message read the target's own messages: the delivery index cannot narrow to
 * one thread. The exclusion is one array parameter, so the statement has the same shape and one
 * bind however many sequences the Agent reports; sequences at or below the lower bound are left out
 * of it, since the bound already excludes them.
 */
function agentAttentionSource(scope: AgentAttentionScope) {
  const readsDeliveries = scope.isChannel && scope.threadRootId === null;
  const sequence = readsDeliveries ? Prisma.raw(`d."sequence"`) : Prisma.raw(`m."sequence"`);
  const lower = scope.afterSequence ?? 0;
  const excluded = scope.excludeSequences?.filter((value) => value > lower) ?? [];
  const bounds = Prisma.sql`${
    scope.afterSequence !== undefined
      ? Prisma.sql` AND ${sequence} > ${scope.afterSequence}`
      : Prisma.empty
  }${excluded.length ? Prisma.sql` AND ${sequence} <> ALL(${excluded}::int[])` : Prisma.empty}${
    scope.ownMemberId
      ? Prisma.sql` AND m."senderMemberId" IS DISTINCT FROM ${scope.ownMemberId}::uuid`
      : Prisma.empty
  }`;
  if (readsDeliveries)
    return {
      sequence,
      from: Prisma.sql`FROM "agent_message_deliveries" d
        JOIN "messages" m ON m."id" = d."messageId" AND m."threadRootId" IS NULL
        WHERE d."agentId" = ${scope.agentId}::uuid AND d."conversationId" = ${scope.conversationId}::uuid${bounds}`,
    };
  const delivered = Prisma.sql`EXISTS (SELECT 1 FROM "agent_message_deliveries" d
    WHERE d."messageId" = m."id" AND d."agentId" = ${scope.agentId}::uuid)`;
  return {
    sequence,
    from: Prisma.sql`FROM "messages" m
      WHERE m."conversationId" = ${scope.conversationId}::uuid AND ${
        scope.threadRootId
          ? Prisma.sql`m."threadRootId" = ${scope.threadRootId}::uuid`
          : Prisma.sql`m."threadRootId" IS NULL`
      }${bounds}
        AND (EXISTS (SELECT 1 FROM "conversation_members" sm
          WHERE sm."id" = m."senderMemberId" AND sm."userId" IS NOT NULL) OR ${delivered})${
            scope.isChannel ? Prisma.sql` AND ${delivered}` : Prisma.empty
          }`,
  };
}

/** The ids of the `take` newest messages of an attention scope, newest first. */
export function agentAttentionIdsSql(scope: AgentAttentionScope, take: number) {
  const { sequence, from } = agentAttentionSource(scope);
  return Prisma.sql`SELECT m."id" ${from} ORDER BY ${sequence} DESC LIMIT ${take}`;
}

/** How many messages an attention scope holds, as `{ count }`. */
export function agentAttentionCountSql(scope: AgentAttentionScope) {
  return Prisma.sql`SELECT COUNT(*)::int AS "count" ${agentAttentionSource(scope).from}`;
}

/** The newest sequence in an attention scope, as `{ max }` (`null` when it holds nothing). */
export function agentAttentionMaxSql(scope: AgentAttentionScope) {
  const { sequence, from } = agentAttentionSource(scope);
  return Prisma.sql`SELECT MAX(${sequence})::int AS "max" ${from}`;
}

/**
 * A target's first-touch window (Raft 1.0.38's `loadRecentTargetMessages`, the target's newest
 * rows): the `take` newest of the messages the Agent owes attention to and its own messages, as
 * `{ id, sequence, seen }`, newest first. The scope's `ownMemberId` is the Agent's member; `seen`
 * marks the Agent's own messages and the scope's excluded sequences (Raft's `isMessageModelSeen`).
 * Each half is its own index range, so the window never walks a channel's history.
 */
export function agentRecentContextSql(scope: AgentAttentionScope, take: number) {
  const attention = agentAttentionSource({
    ...scope,
    afterSequence: undefined,
    excludeSequences: undefined,
  });
  const excluded = scope.excludeSequences?.length ? [...scope.excludeSequences] : [];
  const others = Prisma.sql`(SELECT m."id", ${attention.sequence} AS "sequence",
      ${attention.sequence} = ANY(${excluded}::int[]) AS "seen"
    ${attention.from} ORDER BY ${attention.sequence} DESC LIMIT ${take})`;
  if (!scope.ownMemberId) return Prisma.sql`${others} ORDER BY "sequence" DESC`;
  const own = Prisma.sql`(SELECT o."id", o."sequence", TRUE AS "seen" FROM "messages" o
    WHERE o."conversationId" = ${scope.conversationId}::uuid AND ${
      scope.threadRootId
        ? Prisma.sql`o."threadRootId" = ${scope.threadRootId}::uuid`
        : Prisma.sql`o."threadRootId" IS NULL`
    } AND o."senderMemberId" = ${scope.ownMemberId}::uuid
    ORDER BY o."sequence" DESC LIMIT ${take})`;
  return Prisma.sql`${others} UNION ALL ${own} ORDER BY "sequence" DESC LIMIT ${take}`;
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
 * the *recipient* — the conversation's other member, which a DM target needs and a message's
 * sender cannot supply. It is read whether or not that member has left, the way
 * `conversationTarget` names a DM: someone who left the Workspace still names the DM's history.
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
        WHERE om."conversationId" = c."id" AND om."id" <> am."id"
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
