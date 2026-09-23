import type { PrismaClient } from "#src/generated/prisma/client";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import type { AgentRuntimeCredentialRepository } from "#src/server/agents/agent-runtime-credentials.server";
import type { AgentEnvironmentRepository } from "#src/server/agents/agent-environment.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

export class PrismaAgentRuntimeCredentialRepository
  implements AgentRuntimeCredentialRepository, AgentEnvironmentRepository
{
  constructor(private readonly db: PrismaClient) {}

  async findOwnedAgent(agentId: string, workspaceId: string, ownerId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ownerId, ...ACTIVE_AGENT_WHERE },
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
    await this.db.agent.update({
      where: { id: agentId },
      data: { runtimeConfig },
    });
  }
}
