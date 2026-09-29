import type {
  AgentMentionDeliveryOutcome,
  AgentMentionDeliveryReasonCategory,
} from "@lrm/coforge-sdk/agent";
import type { MentionDeliveryEnvelope, MentionDeliveryStage } from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { parseRuntimeSessionReference } from "./agent-session.repositories.server";

/** A tracked @mention's outcome, as the SDK names them; the migration's CHECK holds the column to
 * these. */
export type MentionOutcome = AgentMentionDeliveryOutcome;
export type MentionReasonCategory = AgentMentionDeliveryReasonCategory;

/** A delivery row's tracked-mention state, as a write that touches it returns it. */
export type TrackedMentionState = {
  mentionOutcome: MentionOutcome | null;
  mentionReasonCategory: MentionReasonCategory | null;
  mentionTerminalCode: string | null;
  mentionLaunchId: string | null;
};
export const TRACKED_MENTION_STATE_SELECT = {
  mentionOutcome: true,
  mentionReasonCategory: true,
  mentionTerminalCode: true,
  mentionLaunchId: true,
} satisfies Prisma.AgentMessageDeliverySelect;

/** The launch and native session an envelope is issued for, on the Agent's Computer. */
export type MentionIdentity = { launchId: string; sessionId: string; computerId: string };

/** What decides whether and how a mention of an Agent can reach it, as stored. */
export type MentionAgentState = {
  computerId: string | null;
  stoppedAt: Date | null;
  deletedAt: Date | null;
  /** The Computer and launch of the persisted launch fence, if any. */
  launch: { computerId: string; launchId?: string } | null;
  /** The current native Session, if any. */
  session: { computerId: string; nativeSessionId: string | null } | null;
};

/** One tracked delivery a daemon report names, and the envelope the report answers. */
export type MentionDeliveryReportKey = {
  workspaceId: string;
  computerId: string;
  agentId: string;
  deliveryId: string;
  envelope: MentionDeliveryEnvelope;
};

/** A mentioning delivery a send may still (re)issue, with its Agent's stored state. */
export type IssuableMention = {
  deliveryId: string;
  messageId: string;
  agentId: string;
  agent: MentionAgentState;
};

/** How a send issues the mentions it pushes; `MentionDeliveryIssuer` decides the plan. */
export type MentionIssuePlan = {
  /** Pushed with an envelope for the Agent's current identity. */
  enveloped: { deliveryId: string; identity: MentionIdentity }[];
  /** Pushed as a wake, without an envelope. */
  wakes: string[];
  /** For an Agent nothing may wake. */
  notLaunched: string[];
};

/** A pending tracked mention and the envelope it last went out with (none: as a wake). */
export type PendingMention = {
  deliveryId: string;
  messageId: string;
  mentionLaunchId: string | null;
  mentionSessionId: string | null;
};

const OPEN_OUTCOMES: MentionOutcome[] = ["pending", "unknown"];
const ISSUABLE_OUTCOME = "pending" satisfies MentionOutcome;
/** A mention not yet settled, which a send may (re)issue. */
const ISSUABLE_WHERE = {
  OR: [{ mentionOutcome: null }, { mentionOutcome: ISSUABLE_OUTCOME }],
} satisfies Prisma.AgentMessageDeliveryWhereInput;
/** A tracked mention a daemon report may still change. Delivered and lost are final, except a
 * person's Stop settling it, which only the daemon's echoed ACK overrides. */
const OPEN_WHERE = {
  mentionOutcome: { in: OPEN_OUTCOMES },
} satisfies Prisma.AgentMessageDeliveryWhereInput;
const STOP_SETTLED_WHERE = {
  mentionOutcome: "lost" satisfies MentionOutcome,
  mentionReasonCategory: "not_launched" satisfies MentionReasonCategory,
  mentionTerminalCode: null,
} satisfies Prisma.AgentMessageDeliveryWhereInput;

const notLaunched = (now: Date) => ({
  mentionOutcome: "lost" satisfies MentionOutcome,
  mentionReasonCategory: "not_launched" satisfies MentionReasonCategory,
  mentionSettledAt: now,
});

const AGENT_STATE_SELECT = {
  computerId: true,
  stoppedAt: true,
  deletedAt: true,
  runtimeSession: true,
  currentSession: { select: { nativeSessionId: true, computerId: true } },
} satisfies Prisma.AgentSelect;

function agentState(
  agent: Prisma.AgentGetPayload<{ select: typeof AGENT_STATE_SELECT }>,
): MentionAgentState {
  const reference = parseRuntimeSessionReference(agent.runtimeSession);
  return {
    computerId: agent.computerId,
    stoppedAt: agent.stoppedAt,
    deletedAt: agent.deletedAt,
    launch: reference ? { computerId: reference.computerId, launchId: reference.launchId } : null,
    session: agent.currentSession,
  };
}

/** The row a report may change: the report's delivery, still carrying the envelope's identity,
 * for an Agent on the reporting Computer. */
function reportedRowWhere(
  key: MentionDeliveryReportKey,
  outcome: Prisma.AgentMessageDeliveryWhereInput = OPEN_WHERE,
) {
  return {
    ...outcome,
    deliveryId: key.deliveryId,
    messageId: key.envelope.messageId,
    workspaceId: key.workspaceId,
    agentId: key.agentId,
    agent: { computerId: key.computerId },
    mentionLaunchId: key.envelope.launchId,
    mentionSessionId: key.envelope.sessionId,
  } satisfies Prisma.AgentMessageDeliveryWhereInput;
}

export type MentionDeliveryDb = Pick<
  PrismaClient,
  "agentMessageDelivery" | "message" | "$queryRaw" | "$transaction"
>;

/** The most messages an anchor is read for: a second one makes it ambiguous. */
const SENDER_ANCHOR_READ_LIMIT = 2;

/** The Agent `a` of delivery `d` may still be woken: not stopped by a person, not deleted, and on
 * a Computer. */
const WAKEABLE_AGENT_SQL = Prisma.sql`a.id = d."agentId"
  AND a."stoppedAt" IS NULL
  AND a."deletedAt" IS NULL
  AND a."computerId" IS NOT NULL`;
/** A mention not yet settled, which a send may (re)issue. */
const ISSUABLE_SQL = Prisma.sql`(d."mentionOutcome" IS NULL OR d."mentionOutcome" = ${ISSUABLE_OUTCOME})`;
/** A pending mention that still carries the envelope `v` read it with. */
const STILL_CARRIED_SQL = Prisma.sql`d."mentionOutcome" = ${ISSUABLE_OUTCOME}
  AND d."mentionLaunchId" IS NOT DISTINCT FROM v."fromLaunchId"
  AND d."mentionSessionId" IS NOT DISTINCT FROM v."fromSessionId"`;

/** One delivery's next envelope (none: a wake), and the one it must still carry, if checked. */
type EnvelopeWrite = {
  deliveryId: string;
  identity: MentionIdentity | undefined;
  carried?: { mentionLaunchId: string | null; mentionSessionId: string | null };
};

/**
 * Issues each delivery pending with its next envelope while `condition` holds and its Agent may
 * still be woken, and returns the ones it issued. The stage always clears; the terminal code only
 * with `clearCode`.
 */
async function setEnvelopes(
  db: Pick<PrismaClient, "$queryRaw">,
  workspaceId: string,
  writes: readonly EnvelopeWrite[],
  condition: Prisma.Sql,
  clearCode: boolean,
): Promise<string[]> {
  if (!writes.length) return [];
  const rows = await db.$queryRaw<{ deliveryId: string }[]>`
    UPDATE "agent_message_deliveries" AS d
    SET "mentionOutcome" = ${ISSUABLE_OUTCOME},
        "mentionStage" = NULL,
        ${clearCode ? Prisma.sql`"mentionTerminalCode" = NULL,` : Prisma.empty}
        "mentionSettledAt" = NULL,
        "mentionLaunchId" = v."launchId",
        "mentionSessionId" = v."sessionId"
    FROM unnest(
      ${writes.map((write) => write.deliveryId)}::uuid[],
      ${writes.map((write) => write.identity?.launchId ?? null)}::text[],
      ${writes.map((write) => write.identity?.sessionId ?? null)}::text[],
      ${writes.map((write) => write.carried?.mentionLaunchId ?? null)}::text[],
      ${writes.map((write) => write.carried?.mentionSessionId ?? null)}::text[]
    ) AS v("deliveryId", "launchId", "sessionId", "fromLaunchId", "fromSessionId"),
      "agents" AS a
    WHERE d."deliveryId" = v."deliveryId"
      AND d."workspaceId" = ${workspaceId}::uuid
      AND ${condition}
      AND ${WAKEABLE_AGENT_SQL}
    RETURNING d."deliveryId"::text AS "deliveryId"`;
  return rows.map((row) => row.deliveryId);
}

/**
 * Storage for tracked @mention outcomes on `agent_message_deliveries`. Every write is conditional
 * on the row still being open, so a late or repeated report never reopens a final outcome.
 */
export class PrismaMentionDeliveryRepository {
  constructor(private readonly db: MentionDeliveryDb) {}

  /**
   * The messages the Agent sent that an anchor (a full id, or its eight-hex prefix) names, at most
   * two, each with its tracked mentions: the mentioned Agent, whether it is deleted, the handle
   * the message wrote for it (from its mention, or its non-member mention action), and the
   * outcome as stored.
   */
  async readSenderDeliveries(workspaceId: string, agentId: string, anchor: string) {
    const messages = await this.db.message.findMany({
      where: { workspaceId, sender: { agentId }, id: messageAnchorWhere(anchor) },
      take: SENDER_ANCHOR_READ_LIMIT,
      select: {
        id: true,
        mentions: { where: { kind: "agent" }, select: { actorId: true, handle: true } },
        pendingMentionActions: {
          where: { targetAgentId: { not: null } },
          select: { targetAgentId: true, targetHandle: true },
        },
        deliveries: {
          where: { mentionOutcome: { not: null } },
          select: {
            agentId: true,
            mentionOutcome: true,
            mentionReasonCategory: true,
            agent: { select: { name: true, deletedAt: true } },
          },
        },
      },
    });
    return messages.map((message) => {
      const written = new Map<string, string>([
        ...message.pendingMentionActions.map(
          (action) => [action.targetAgentId!, action.targetHandle] as const,
        ),
        ...message.mentions.map((mention) => [mention.actorId, mention.handle] as const),
      ]);
      return {
        messageId: message.id,
        deliveries: message.deliveries.map((row) => ({
          agentId: row.agentId,
          writtenHandle: written.get(row.agentId),
          currentName: row.agent.name,
          deleted: row.agent.deletedAt !== null,
          outcome: row.mentionOutcome as MentionOutcome,
          reasonCategory: row.mentionReasonCategory as MentionReasonCategory | null,
        })),
      };
    });
  }
  /**
   * Issues a send's mentioning deliveries in one transaction. It holds their Agents' rows
   * (`FOR SHARE`) before reading their state, so `decide` plans from what a session report or a
   * person's Stop committed first, and one that comes later waits for this to commit and then sees
   * what it wrote. Returns the enveloped deliveries it issued.
   */
  async issue(
    workspaceId: string,
    deliveryIds: readonly string[],
    decide: (mentions: IssuableMention[]) => MentionIssuePlan,
    now: Date,
  ): Promise<Set<string>> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT a.id FROM "agents" AS a
        JOIN "agent_message_deliveries" AS d ON d."agentId" = a.id
        WHERE d."workspaceId" = ${workspaceId}::uuid
          AND d."deliveryId" = ANY(${[...deliveryIds]}::uuid[])
        ORDER BY a.id
        FOR SHARE OF a`;
      const rows = await tx.agentMessageDelivery.findMany({
        where: { ...ISSUABLE_WHERE, workspaceId, deliveryId: { in: [...deliveryIds] } },
        select: {
          deliveryId: true,
          messageId: true,
          agentId: true,
          agent: { select: AGENT_STATE_SELECT },
        },
      });
      const plan = decide(rows.map(({ agent, ...row }) => ({ ...row, agent: agentState(agent) })));
      const enveloped = await setEnvelopes(
        tx,
        workspaceId,
        [
          ...plan.enveloped,
          ...plan.wakes.map((deliveryId) => ({ deliveryId, identity: undefined })),
        ],
        ISSUABLE_SQL,
        true,
      );
      if (plan.notLaunched.length)
        await tx.agentMessageDelivery.updateMany({
          where: { ...ISSUABLE_WHERE, workspaceId, deliveryId: { in: plan.notLaunched } },
          data: {
            ...notLaunched(now),
            mentionStage: null,
            mentionTerminalCode: null,
            mentionLaunchId: null,
            mentionSessionId: null,
          },
        });
      const wakes = new Set(plan.wakes);
      return new Set(enveloped.filter((deliveryId) => !wakes.has(deliveryId)));
    });
  }

  /** An Agent's stored state and its pending tracked mentions, read together; undefined when it
   * has none in the Workspace. */
  async readPending(workspaceId: string, agentId: string) {
    return this.db.$transaction(async (tx) => {
      const mentions: PendingMention[] = await tx.agentMessageDelivery.findMany({
        where: { workspaceId, agentId, mentionOutcome: ISSUABLE_OUTCOME },
        select: {
          deliveryId: true,
          messageId: true,
          mentionLaunchId: true,
          mentionSessionId: true,
        },
      });
      if (!mentions.length) return undefined;
      const agent = await tx.agent.findFirst({
        where: { id: agentId, workspaceId },
        select: AGENT_STATE_SELECT,
      });
      return agent ? { agent: agentState(agent), mentions } : undefined;
    });
  }

  /**
   * Issues an Agent's pending mentions again: for `identity`, clearing the terminal code a drift
   * counted against the launch they left; or, with none, as wakes that keep it. Each changes only
   * while it still carries the envelope it was read with, so a concurrent re-issue or drift answer
   * wins and this leaves it alone. Returns the deliveries it issued.
   */
  async reissuePending(
    scope: { workspaceId: string; agentId: string },
    mentions: readonly PendingMention[],
    identity: MentionIdentity | undefined,
  ): Promise<string[]> {
    return setEnvelopes(
      this.db,
      scope.workspaceId,
      mentions.map((mention) => ({ deliveryId: mention.deliveryId, identity, carried: mention })),
      Prisma.sql`d."agentId" = ${scope.agentId}::uuid AND ${STILL_CARRIED_SQL}`,
      identity !== undefined,
    );
  }

  /** After a failed issue, the pushes carry no envelope: no pending row may still name one. */
  async clearEnvelopes(workspaceId: string, deliveryIds: readonly string[]) {
    await this.db.agentMessageDelivery.updateMany({
      where: {
        workspaceId,
        deliveryId: { in: [...deliveryIds] },
        mentionOutcome: ISSUABLE_OUTCOME,
        mentionLaunchId: { not: null },
      },
      data: { mentionLaunchId: null, mentionSessionId: null },
    });
  }

  /** A person stopped the Agent: its still-pending tracked mentions will not be launched. */
  async settleStopped(input: { workspaceId: string; agentId: string; stoppedAt: Date }) {
    await this.db.agentMessageDelivery.updateMany({
      where: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        mentionOutcome: ISSUABLE_OUTCOME,
      },
      data: notLaunched(input.stoppedAt),
    });
  }

  /** An ACK that echoes the delivery's current envelope: delivered, even after a Stop settled
   * it. */
  async settleDrained(key: MentionDeliveryReportKey, now: Date) {
    await this.db.agentMessageDelivery.updateMany({
      where: reportedRowWhere(key, { OR: [OPEN_WHERE, STOP_SETTLED_WHERE] }),
      data: {
        mentionOutcome: "delivered" satisfies MentionOutcome,
        mentionReasonCategory: null,
        mentionSettledAt: now,
      },
    });
  }

  /** An ACK without an envelope for a delivery that was sent with one: the daemon could not say
   * whether the mention reached the session. */
  async settleUnechoed(
    input: { workspaceId: string; computerId: string; agentId: string; deliveryId: string },
    now: Date,
  ) {
    await this.db.agentMessageDelivery.updateMany({
      where: {
        deliveryId: input.deliveryId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agent: { computerId: input.computerId },
        mentionOutcome: ISSUABLE_OUTCOME,
        mentionLaunchId: { not: null },
      },
      data: { mentionOutcome: "unknown" satisfies MentionOutcome, mentionSettledAt: now },
    });
  }

  async recordStage(key: MentionDeliveryReportKey, stage: MentionDeliveryStage) {
    await this.db.agentMessageDelivery.updateMany({
      where: reportedRowWhere(key),
      data: { mentionStage: stage },
    });
  }

  /** The open row a report answers: the code already recorded and its Agent's state. */
  async settleTerminal(key: MentionDeliveryReportKey, result: TerminalSettlement, now: Date) {
    await this.db.agentMessageDelivery.updateMany({
      where: reportedRowWhere(key),
      data: settledData(result, now),
    });
  }

  /**
   * Answers an identity report in one transaction that holds the Agent's row (`FOR SHARE`) while
   * it reads the reported mention and writes `decide`'s answer, so a session that is being
   * accepted either committed first and is seen, or waits for this and then re-issues what it
   * wrote. Returns the answer written, or undefined when the mention no longer carries the
   * report's envelope.
   */
  async answerReported(
    key: MentionDeliveryReportKey,
    decide: (reported: { terminalCode: string | null; agent: MentionAgentState }) => ReportAnswer,
    now: Date,
  ): Promise<ReportAnswer | undefined> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "agents" WHERE id = ${key.agentId}::uuid FOR SHARE`;
      const row = await tx.agentMessageDelivery.findFirst({
        where: reportedRowWhere(key),
        select: { mentionTerminalCode: true, agent: { select: AGENT_STATE_SELECT } },
      });
      if (!row) return undefined;
      const answer = decide({
        terminalCode: row.mentionTerminalCode,
        agent: agentState(row.agent),
      });
      const { count } = await tx.agentMessageDelivery.updateMany({
        where: reportedRowWhere(key),
        data:
          "settle" in answer
            ? settledData(answer.settle, now)
            : {
                mentionOutcome: ISSUABLE_OUTCOME,
                mentionStage: null,
                mentionLaunchId: answer.reissue?.launchId ?? null,
                mentionSessionId: answer.reissue?.sessionId ?? null,
                mentionTerminalCode: answer.code,
                mentionSettledAt: null,
              },
      });
      return count === 1 ? answer : undefined;
    });
  }
}

/** How a daemon's terminal report settles a mention. */
export type TerminalSettlement = {
  outcome: Extract<MentionOutcome, "lost" | "unknown">;
  reason: MentionReasonCategory | null;
  code: string;
};

/** An identity report's answer: settle the mention, or keep it pending for `reissue` (none:
 * without an envelope), recording the report's code. */
export type ReportAnswer =
  | { settle: TerminalSettlement }
  | { reissue: MentionIdentity | undefined; code: string };

function settledData(result: TerminalSettlement, now: Date) {
  return {
    mentionOutcome: result.outcome,
    mentionReasonCategory: result.reason,
    mentionTerminalCode: result.code,
    mentionSettledAt: now,
  } satisfies Prisma.AgentMessageDeliveryUpdateManyMutationInput;
}
