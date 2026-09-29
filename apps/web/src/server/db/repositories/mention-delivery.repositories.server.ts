import type { MentionDeliveryEnvelope, MentionDeliveryStage } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { parseRuntimeSessionReference } from "./agent-session.repositories.server";

/** A tracked @mention's outcome; the migration's CHECK holds the column to these. */
export type MentionOutcome = "pending" | "delivered" | "lost" | "unknown";
export type MentionReasonCategory = "quota" | "runtime_error" | "not_launched" | "unclassified";

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

/** How a send issues the mentions it pushes; `MentionDeliveryIssuer` decides the plan. */
export type MentionIssuePlan = {
  /** Every mentioning delivery planned below, and their Agents. */
  deliveryIds: string[];
  agentIds: string[];
  /** Pushed as a wake, without an envelope. */
  wakes: string[];
  /** Pushed with an envelope for the Agent's current identity. */
  enveloped: { deliveryId: string; identity: MentionIdentity }[];
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

type MentionDeliveryDb = Pick<PrismaClient, "agentMessageDelivery" | "$queryRaw" | "$transaction">;

/**
 * Storage for tracked @mention outcomes on `agent_message_deliveries`. Every write is conditional
 * on the row still being open, so a late or repeated report never reopens a final outcome.
 */
export class PrismaMentionDeliveryRepository {
  constructor(private readonly db: MentionDeliveryDb) {}

  /** The deliveries a send may still (re)issue, each with its Agent's stored state. */
  async readIssuable(workspaceId: string, deliveryIds: readonly string[]) {
    const rows = await this.db.agentMessageDelivery.findMany({
      where: { ...ISSUABLE_WHERE, workspaceId, deliveryId: { in: [...deliveryIds] } },
      select: {
        deliveryId: true,
        messageId: true,
        agentId: true,
        agent: { select: AGENT_STATE_SELECT },
      },
    });
    return rows.map(({ agent, ...row }) => ({ ...row, agent: agentState(agent) }));
  }

  /**
   * Writes an issue plan in one transaction that holds each Agent's row, so a person's Stop
   * either commits first and is seen here, or waits and then settles what this wrote. A planned
   * delivery whose Agent can no longer be woken is settled not launched instead. Returns the
   * enveloped deliveries it marked.
   */
  async issue(workspaceId: string, plan: MentionIssuePlan, now: Date): Promise<Set<string>> {
    if (!plan.deliveryIds.length) return new Set();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "agents"
        WHERE id = ANY(${[...new Set(plan.agentIds)].sort()}::uuid[])
        ORDER BY id
        FOR SHARE`;
      const wakeableAgent = {
        agent: { stoppedAt: null, deletedAt: null, computerId: { not: null } },
      } satisfies Prisma.AgentMessageDeliveryWhereInput;
      const marked = plan.enveloped.length
        ? await tx.$queryRaw<{ deliveryId: string }[]>`
            UPDATE "agent_message_deliveries" AS d
            SET "mentionOutcome" = ${ISSUABLE_OUTCOME},
                "mentionStage" = NULL,
                "mentionTerminalCode" = NULL,
                "mentionLaunchId" = v."launchId",
                "mentionSessionId" = v."sessionId"
            FROM unnest(
              ${plan.enveloped.map((row) => row.deliveryId)}::uuid[],
              ${plan.enveloped.map((row) => row.identity.launchId)}::text[],
              ${plan.enveloped.map((row) => row.identity.sessionId)}::text[]
            ) AS v("deliveryId", "launchId", "sessionId"), "agents" AS a
            WHERE d."deliveryId" = v."deliveryId"
              AND d."workspaceId" = ${workspaceId}::uuid
              AND (d."mentionOutcome" IS NULL OR d."mentionOutcome" = ${ISSUABLE_OUTCOME})
              AND a.id = d."agentId"
              AND a."stoppedAt" IS NULL
              AND a."deletedAt" IS NULL
              AND a."computerId" IS NOT NULL
            RETURNING d."deliveryId"::text AS "deliveryId"`
        : [];
      if (plan.wakes.length)
        await tx.agentMessageDelivery.updateMany({
          where: {
            ...ISSUABLE_WHERE,
            ...wakeableAgent,
            workspaceId,
            deliveryId: { in: plan.wakes },
          },
          data: {
            mentionOutcome: ISSUABLE_OUTCOME,
            mentionStage: null,
            mentionTerminalCode: null,
            mentionLaunchId: null,
            mentionSessionId: null,
          },
        });
      await tx.agentMessageDelivery.updateMany({
        where: {
          ...ISSUABLE_WHERE,
          workspaceId,
          deliveryId: { in: plan.deliveryIds },
          NOT: wakeableAgent,
        },
        data: {
          ...notLaunched(now),
          mentionStage: null,
          mentionTerminalCode: null,
          mentionLaunchId: null,
          mentionSessionId: null,
        },
      });
      return new Set(marked.map((row) => row.deliveryId));
    });
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
  async readReported(key: MentionDeliveryReportKey) {
    const row = await this.db.agentMessageDelivery.findFirst({
      where: reportedRowWhere(key),
      select: { mentionTerminalCode: true, agent: { select: AGENT_STATE_SELECT } },
    });
    return row
      ? { terminalCode: row.mentionTerminalCode, agent: agentState(row.agent) }
      : undefined;
  }

  async settleTerminal(
    key: MentionDeliveryReportKey,
    result: {
      outcome: Extract<MentionOutcome, "lost" | "unknown">;
      reason: MentionReasonCategory | null;
      code: string;
    },
    now: Date,
  ) {
    await this.db.agentMessageDelivery.updateMany({
      where: reportedRowWhere(key),
      data: {
        mentionOutcome: result.outcome,
        mentionReasonCategory: result.reason,
        mentionTerminalCode: result.code,
        mentionSettledAt: now,
      },
    });
  }

  /** Keeps the mention pending under a new identity (none for a wake), recording the code that
   * caused it. */
  async reissue(
    key: MentionDeliveryReportKey,
    identity: MentionIdentity | undefined,
    code: string,
  ) {
    const { count } = await this.db.agentMessageDelivery.updateMany({
      where: reportedRowWhere(key),
      data: {
        mentionOutcome: ISSUABLE_OUTCOME,
        mentionStage: null,
        mentionLaunchId: identity?.launchId ?? null,
        mentionSessionId: identity?.sessionId ?? null,
        mentionTerminalCode: code,
        mentionSettledAt: null,
      },
    });
    return count === 1;
  }
}
