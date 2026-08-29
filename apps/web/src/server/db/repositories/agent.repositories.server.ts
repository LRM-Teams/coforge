import type { PrismaClient } from "../../../../generated/client";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@coforge/protocol";

export type AgentRuntimeConfig = {
  provider: RuntimeProvider;
  model: string;
  reasoning: string;
};

export type AgentRecord = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  createdAt: Date;
  ownerId: string;
  runtimeConfig: AgentRuntimeConfig;
};

function runtimeProvider(value: unknown): RuntimeProvider | undefined {
  if (value === RUNTIME_PROVIDER.PI) return RUNTIME_PROVIDER.PI;
  if (value === RUNTIME_PROVIDER.CODEX) return RUNTIME_PROVIDER.CODEX;
  if (value === RUNTIME_PROVIDER.CLAUDE_CODE) return RUNTIME_PROVIDER.CLAUDE_CODE;
  return undefined;
}

function mapAgent(agent: {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  createdAt: Date;
  ownerId: string;
  runtimeConfig: unknown;
}): AgentRecord {
  const value = agent.runtimeConfig;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Agent ${agent.id} has invalid runtime config`);
  const provider = runtimeProvider(Reflect.get(value, "provider"));
  const model = Reflect.get(value, "model");
  const reasoning = Reflect.get(value, "reasoning");
  if (!provider || typeof model !== "string" || typeof reasoning !== "string")
    throw new Error(`Agent ${agent.id} has invalid runtime config`);
  return { ...agent, runtimeConfig: { provider, model, reasoning } };
}

export interface AgentRepository {
  getById(id: string): Promise<AgentRecord | undefined>;
  listInWorkspace(workspaceId: string): Promise<AgentRecord[]>;
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
}
