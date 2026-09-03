import type { PrismaClient } from "../../../../generated/client";
import { parseAgentRuntimeConfig } from "../../agents/agent-runtime-config.server";
import type { AgentRuntimeCredentialRepository } from "../../agents/agent-runtime-credentials.server";

export class PrismaAgentRuntimeCredentialRepository implements AgentRuntimeCredentialRepository {
  constructor(private readonly db: PrismaClient) {}

  async findOwnedAgent(agentId: string, workspaceId: string, ownerId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ownerId },
      select: { runtimeConfig: true },
    });
    if (!agent) return undefined;
    try {
      return { runtimeConfig: parseAgentRuntimeConfig(agent.runtimeConfig) };
    } catch {
      return undefined;
    }
  }

  async updateRuntimeConfig(
    agentId: string,
    runtimeConfig: Parameters<AgentRuntimeCredentialRepository["updateRuntimeConfig"]>[1],
  ) {
    await this.db.agent.update({ where: { id: agentId }, data: { runtimeConfig } });
  }
}
