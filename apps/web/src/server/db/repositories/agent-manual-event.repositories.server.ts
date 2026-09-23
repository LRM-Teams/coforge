import type { PrismaClient } from "@/generated/prisma/client";
import type { AgentManualEventRepository } from "@/server/agents/agent-manual.server";

export class PrismaAgentManualEventRepository implements AgentManualEventRepository {
  constructor(private readonly db: PrismaClient) {}

  async record(event: {
    workspaceId: string;
    agentId: string;
    kind: "get" | "search";
    topicOrQuery: string;
    intent: string;
    reason: string;
    outcome: "hit" | "not_found";
    resultSlugs: string[];
  }): Promise<void> {
    await this.db.agentManualEvent.create({
      data: {
        workspaceId: event.workspaceId,
        agentId: event.agentId,
        kind: event.kind,
        topicOrQuery: event.topicOrQuery,
        intent: event.intent,
        reason: event.reason,
        outcome: event.outcome,
        resultSlugs: event.resultSlugs,
      },
    });
  }
}
