import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { parseActivityEntries, type AgentActivity } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { activityKindForObservation } from "#src/server/agents/agent-display.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForUser,
  visibleAgentWhere,
} from "#src/server/agents/agent-visibility.server";
import { AGENT_ACTIVITY_WINDOW } from "#src/features/agents/agent-activity-window";

export type TrustedAgentActivity = AgentActivity & { computerId: string };

type CompactActivity = {
  agentId: string;
  id: string;
  launchId: string;
  clientSeq: number;
  detailKind: string;
  level: string;
  detail: string;
  entries: unknown;
  occurredAt: Date;
  createdAt: Date;
  slot: bigint;
};

type CompactActivityRow =
  | CompactActivity
  | (Record<Exclude<keyof CompactActivity, "agentId">, null> & {
      agentId: string;
    });

function activityKind(activity: { detailKind: string; level: string }) {
  if (activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.STOPPED) return "offline" as const;
  if (!(["info", "warning", "error"] as const).some((level) => level === activity.level))
    return undefined;
  return activityKindForObservation({
    detailKind: activity.detailKind,
    level: activity.level === "error" ? "error" : activity.level === "warning" ? "warning" : "info",
  });
}

export class AgentActivityRepository {
  constructor(private readonly db: PrismaClient) {}

  async listForMember(workspaceId: string, userId: string) {
    // A private Agent the viewer cannot see never contributes an Activity row here —
    // the same `visibleAgentWhere` predicate every Agent list applies, resolved once against the
    // viewer's own Workspace role and reused as a plain id filter inside the CTE below (SQL never
    // re-derives the visibility rule itself, so the two can never disagree).
    const viewer = await agentVisibilityViewerForUser(this.db, workspaceId, userId);
    const visibleAgents = await this.db.agent.findMany({
      where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(viewer) },
      select: { id: true },
    });
    const visibleAgentIds = visibleAgents.map((agent) => agent.id);
    if (visibleAgentIds.length === 0) return [];
    // Excluded from the popover's top-5 selection only: tool_end,
    // thinking_end and compaction_finished are ordinary, persisted status rows in the Agent
    // detail Activity feed (AgentActivityRepository.list), but they occur once per tool call
    // or thinking phase and would crowd out genuinely noteworthy events in this short list.
    const excludedTool = AGENT_ACTIVITY_DETAIL_KIND.TOOL_END;
    const excludedThinking = AGENT_ACTIVITY_DETAIL_KIND.THINKING_END;
    const excludedCompaction = AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED;
    const excludedReview = AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED;
    const rows = await this.db.$queryRaw<CompactActivityRow[]>`
      WITH authorized_agents AS (
        SELECT agent."id"
        FROM "agents" AS agent
        INNER JOIN "workspace_memberships" AS membership
          ON membership."workspaceId" = agent."workspaceId"
        WHERE agent."workspaceId" = ${workspaceId}::uuid
          AND agent."deletedAt" IS NULL
          AND membership."userId" = ${userId}::uuid
          AND agent."id" = ANY(${visibleAgentIds}::uuid[])
      ),
      -- Each Agent's five newest shown rows, read from the head of its
      -- (workspaceId, agentId, occurredAt DESC) index instead of ranking its whole history.
      recent AS (
        SELECT
          agent."id" AS "agentId",
          recent."launchId",
          ROW_NUMBER() OVER (
            PARTITION BY agent."id"
            ORDER BY recent."occurredAt" DESC, recent."createdAt" DESC, recent."id" DESC
          ) AS slot
        FROM authorized_agents AS agent
        CROSS JOIN LATERAL (
          SELECT activity."id", activity."launchId", activity."occurredAt", activity."createdAt"
          FROM "agent_activities" AS activity
          WHERE activity."workspaceId" = ${workspaceId}::uuid
            AND activity."agentId" = agent."id"
            AND activity."detailKind" NOT IN (${excludedTool}, ${excludedThinking}, ${excludedCompaction}, ${excludedReview})
          ORDER BY activity."occurredAt" DESC, activity."createdAt" DESC, activity."id" DESC
          LIMIT 5
        ) AS recent
      ),
      -- A clock rollback can reorder a launch's rows by time, so the slot's k-th newest row of
      -- its launch shows that launch's k-th highest clientSeq instead. Every newer row of the
      -- launch is also newer overall, so k is its rank among these five slots.
      positioned AS (
        SELECT
          recent.*,
          ROW_NUMBER() OVER (
            PARTITION BY recent."agentId", recent."launchId"
            ORDER BY recent.slot
          ) AS launch_position
        FROM recent
      ),
      compact AS (
        SELECT sequenced.*, positioned.slot
        FROM positioned
        CROSS JOIN LATERAL (
          SELECT
            activity."id",
            activity."agentId",
            activity."launchId",
            activity."clientSeq",
            activity."detailKind",
            activity."level",
            activity."detail",
            activity."entries",
            activity."occurredAt",
            activity."createdAt"
          FROM "agent_activities" AS activity
          WHERE activity."workspaceId" = ${workspaceId}::uuid
            AND activity."agentId" = positioned."agentId"
            AND activity."launchId" = positioned."launchId"
            AND activity."detailKind" NOT IN (${excludedTool}, ${excludedThinking}, ${excludedCompaction}, ${excludedReview})
          ORDER BY activity."clientSeq" DESC
          OFFSET positioned.launch_position - 1
          LIMIT 1
        ) AS sequenced
      )
      SELECT
        agent."id" AS "agentId",
        compact."id",
        compact."launchId",
        compact."clientSeq",
        compact."detailKind",
        compact."level",
        compact."detail",
        compact."entries",
        compact."occurredAt",
        compact."createdAt",
        compact.slot
      FROM authorized_agents AS agent
      LEFT JOIN compact ON compact."agentId" = agent."id"
      ORDER BY agent."id", compact.slot ASC NULLS LAST
    `;
    const agents = new Map<string, { id: string; activity: CompactActivity[] }>();
    for (const row of rows) {
      const agent = agents.get(row.agentId) ?? {
        id: row.agentId,
        activity: [],
      };
      agents.set(row.agentId, agent);
      if (row.id === null) continue;
      agent.activity.push(row);
    }
    return [...agents.values()].map(({ id, activity }) => ({
      id,
      activity: activity.map(
        ({
          id: activityId,
          launchId,
          clientSeq,
          detailKind,
          level,
          detail,
          entries,
          occurredAt,
          createdAt,
        }) => ({
          id: activityId,
          launchId,
          clientSeq,
          detailKind,
          level,
          detail,
          activityKind: activityKind({ detailKind, level }),
          entries: entries === null ? [] : parseActivityEntries(entries),
          observedAtMs: occurredAt.getTime(),
          createdAt,
        }),
      ),
    }));
  }

  async record(input: TrustedAgentActivity) {
    await this.db.agentActivity.createMany({
      data: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        computerId: input.computerId,
        launchId: input.launchId,
        clientSeq: input.clientSeq,
        detailKind: input.detailKind,
        level: input.level,
        detail: input.detail,
        entries: input.entries,
        runtimeErrorClass: input.runtimeError?.errorClass,
        runtimeErrorReason: input.runtimeError?.errorReason,
        runtimeErrorFingerprint: input.runtimeError?.fingerprint,
        occurredAt: new Date(input.observedAtMs),
      },
      skipDuplicates: true,
    });
  }

  async list(workspaceId: string, agentId: string) {
    const rows = await this.db.agentActivity.findMany({
      where: { workspaceId, agentId },
      orderBy: [{ occurredAt: "desc" }, { clientSeq: "desc" }, { createdAt: "desc" }],
      take: AGENT_ACTIVITY_WINDOW,
    });
    return rows.map(
      ({
        occurredAt,
        entries,
        runtimeErrorClass,
        runtimeErrorReason,
        runtimeErrorFingerprint,
        ...row
      }) => ({
        ...row,
        activityKind: activityKind(row),
        observedAtMs: occurredAt.getTime(),
        entries: entries === null ? [] : parseActivityEntries(entries),
        ...(runtimeErrorClass
          ? {
              runtimeError: {
                errorClass: runtimeErrorClass,
                errorReason: runtimeErrorReason ?? "",
                fingerprint: runtimeErrorFingerprint ?? "",
              },
            }
          : {}),
      }),
    );
  }
}
