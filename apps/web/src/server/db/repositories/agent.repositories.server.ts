import type { PrismaClient } from "../../../../generated/client";
import {
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "../../agents/agent-runtime-config.server";

export type { AgentRuntimeConfig } from "../../agents/agent-runtime-config.server";

export type AgentRecord = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  createdAt: Date;
  ownerId: string;
  computerId?: string;
  runtimeConfig: AgentRuntimeConfig;
};

function mapAgent(agent: {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  createdAt: Date;
  ownerId: string;
  computerId: string | null;
  runtimeConfig: unknown;
}): AgentRecord {
  let runtimeConfig;
  try {
    runtimeConfig = parseAgentRuntimeConfig(agent.runtimeConfig);
  } catch {
    throw new Error(`Agent ${agent.id} has invalid runtime config`);
  }
  const { computerId, description, ...fields } = agent;
  return {
    ...fields,
    description: description ?? "",
    ...(computerId ? { computerId } : {}),
    runtimeConfig,
  };
}

export interface AgentRepository {
  getById(id: string): Promise<AgentRecord | undefined>;
  listInWorkspace(workspaceId: string): Promise<AgentRecord[]>;
  listForComputer(workspaceId: string, computerId: string): Promise<AgentRecord[]>;
  listOwnedInWorkspace(workspaceId: string, ownerId: string): Promise<AgentRecord[]>;
  create(input: Omit<AgentRecord, "id" | "createdAt">): Promise<AgentRecord>;
}

export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly db: PrismaClient) {}

  async getById(id: string) {
    const agent = await this.db.agent.findUnique({ where: { id } });
    return agent ? mapAgent(agent) : undefined;
  }

  async listInWorkspace(workspaceId: string) {
    const agents = await this.db.agent.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return agents.map(mapAgent);
  }

  async listForComputer(workspaceId: string, computerId: string) {
    const agents = await this.db.agent.findMany({
      where: { workspaceId, computerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return agents.map(mapAgent);
  }

  async listOwnedInWorkspace(workspaceId: string, ownerId: string) {
    const agents = await this.db.agent.findMany({
      where: { workspaceId, ownerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return agents.map(mapAgent);
  }

  async create(input: Omit<AgentRecord, "id" | "createdAt">) {
    return mapAgent(await this.db.agent.create({ data: input }));
  }
}

export class RepositoryAgentAuthorization {
  constructor(private readonly agents: AgentRepository) {}

  async canUseAgent(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.agents.getById(agentId);
    return agent?.workspaceId === workspaceId && agent.ownerId === userId;
  }

  async computerIdForAuthorizedAgent(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.agents.getById(agentId);
    if (agent?.workspaceId !== workspaceId || agent.ownerId !== userId) return undefined;
    return agent.computerId;
  }
}
