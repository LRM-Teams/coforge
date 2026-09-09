import type { PrismaClient } from "../../../../generated/client";
import { enrollGeneralChannel } from "../../conversations/public-channels.server";
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
  runtimeSession?: unknown;
}): AgentRecord {
  let runtimeConfig;
  try {
    runtimeConfig = parseAgentRuntimeConfig(agent.runtimeConfig);
  } catch {
    throw new Error(`Agent ${agent.id} has invalid runtime config`);
  }
  const { computerId, description } = agent;
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    displayName: agent.displayName,
    createdAt: agent.createdAt,
    ownerId: agent.ownerId,
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
  create(input: Omit<AgentRecord, "id" | "createdAt"> & { id?: string }): Promise<AgentRecord>;
  update(
    id: string,
    input: Pick<AgentRecord, "name" | "displayName" | "description"> &
      Partial<Pick<AgentRecord, "runtimeConfig">>,
  ): Promise<AgentRecord>;
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

  async create(input: Omit<AgentRecord, "id" | "createdAt"> & { id?: string }) {
    return this.db.$transaction(async (tx) => {
      const agent = mapAgent(await tx.agent.create({ data: input }));
      await enrollGeneralChannel(tx, input.workspaceId);
      return agent;
    });
  }

  async update(
    id: string,
    input: Pick<AgentRecord, "name" | "displayName" | "description"> &
      Partial<Pick<AgentRecord, "runtimeConfig">>,
  ) {
    return mapAgent(await this.db.agent.update({ where: { id }, data: input }));
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
