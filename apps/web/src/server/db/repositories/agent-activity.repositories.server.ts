import type { AgentActivity } from "@coforge/protocol";
import type { PrismaClient } from "../../../../generated/client";

export type TrustedAgentActivity = AgentActivity & { computerId: string };

type CompactActivity = {
  agentId: string;
  id: string;
  launchId: string;
  clientSeq: number;
  activity: string;
  level: string;
  occurredAt: Date;
  createdAt: Date;
  slot: bigint;
};

type CompactActivityRow =
  | CompactActivity
  | (Record<Exclude<keyof CompactActivity, "agentId">, null> & {
      agentId: string;
    });

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
          activity."activity",
          activity."level",
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
        compact."activity",
        compact."level",
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
          activity: activityName,
          level,
          occurredAt,
          createdAt,
        }) => ({
          id: activityId,
          launchId,
          clientSeq,
          activity: activityName,
          level,
          occurredAt,
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
        activity: input.activity,
        level: input.level,
        message: input.message,
        diagnosticErrorClass: input.diagnostic?.errorClass,
        diagnosticReason: input.diagnostic?.reason,
        diagnosticFingerprint: input.diagnostic?.fingerprint,
        occurredAt: new Date(input.occurredAt),
      },
      skipDuplicates: true,
    });
  }

  list(workspaceId: string, agentId: string) {
    return this.db.agentActivity.findMany({
      where: { workspaceId, agentId },
      orderBy: [{ occurredAt: "desc" }, { clientSeq: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
  }
}
