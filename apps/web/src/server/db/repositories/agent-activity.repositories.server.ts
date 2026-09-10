import { parseActivityEntries, type AgentActivity } from "@coforge/protocol";
import type { PrismaClient } from "../../../../generated/client";
import { activityKindForObservation } from "../../agents/agent-display.server";

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
  if (activity.detailKind === "stopped") return "offline" as const;
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
    const rows = await this.db.$queryRaw<CompactActivityRow[]>`
      WITH authorized_agents AS (
        SELECT agent."id"
        FROM "agents" AS agent
        INNER JOIN "workspace_memberships" AS membership
          ON membership."workspaceId" = agent."workspaceId"
        WHERE agent."workspaceId" = ${workspaceId}::uuid
          AND membership."userId" = ${userId}::uuid
      ),
      ranked AS (
        SELECT
          activity."agentId",
          activity."launchId",
          ROW_NUMBER() OVER (
            PARTITION BY activity."agentId"
            ORDER BY activity."occurredAt" DESC, activity."createdAt" DESC, activity."id" DESC
          ) AS slot,
          ROW_NUMBER() OVER (
            PARTITION BY activity."agentId", activity."launchId"
            ORDER BY activity."occurredAt" DESC, activity."createdAt" DESC, activity."id" DESC
          ) AS launch_chronological_position
        FROM "agent_activities" AS activity
        INNER JOIN authorized_agents AS agent ON agent."id" = activity."agentId"
        WHERE activity."workspaceId" = ${workspaceId}::uuid
      ),
      sequence_ranked AS (
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
          activity."createdAt",
          ROW_NUMBER() OVER (
            PARTITION BY activity."agentId", activity."launchId"
            ORDER BY activity."clientSeq" DESC
          ) AS launch_sequence_position
        FROM "agent_activities" AS activity
        INNER JOIN authorized_agents AS agent ON agent."id" = activity."agentId"
        WHERE activity."workspaceId" = ${workspaceId}::uuid
      ),
      compact AS (
        SELECT sequence_ranked.*, ranked.slot
        FROM ranked
        INNER JOIN sequence_ranked
          ON sequence_ranked."agentId" = ranked."agentId"
          AND sequence_ranked."launchId" = ranked."launchId"
          AND sequence_ranked.launch_sequence_position = ranked.launch_chronological_position
        WHERE ranked.slot <= 5
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
      take: 100,
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
