import type { AgentActivity } from "@coforge/protocol";
import type { PrismaClient } from "../../../../generated/client";

export type TrustedAgentActivity = AgentActivity & { computerId: string };

export class AgentActivityRepository {
  constructor(private readonly db: PrismaClient) {}

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
