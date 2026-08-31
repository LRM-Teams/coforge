import { RUNTIME_PROVIDER, type AgentStartIntent, type RuntimeProvider } from "@coforge/protocol";
import type { AgentRecord, AgentRepository } from "../db/repositories/agent.repositories.server";

const providers = new Set<unknown>(Object.values(RUNTIME_PROVIDER));
const HANDLE_MAX_LENGTH = 48;
const DISPLAY_NAME_MAX_LENGTH = 100;
const CONFIG_VALUE_MAX_LENGTH = 200;

export type AgentCreateInput = {
  name: string;
  displayName: string;
  provider: RuntimeProvider;
  model?: string;
  modelProvider?: string;
  reasoning?: string;
  computerId: string;
};

type AgentPrincipal = { userId: string; workspaceId: string };
type AgentStarter = {
  start(intent: AgentStartIntent, userId: string): Promise<void>;
};
type RuntimeAvailability = {
  canRun(
    workspaceId: string,
    computerId: string,
    config: { provider: RuntimeProvider; model: string; modelProvider: string; reasoning: string },
  ): Promise<boolean>;
};

function bounded(value: string | undefined, label: string, maximum: number) {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

export class AgentCollection {
  constructor(
    private readonly agents: AgentRepository,
    private readonly starter: AgentStarter,
    private readonly availability: RuntimeAvailability,
  ) {}

  list(principal: AgentPrincipal) {
    return this.agents.listOwnedInWorkspace(principal.workspaceId, principal.userId);
  }

  async create(principal: AgentPrincipal, input: AgentCreateInput) {
    const name = input.name.trim().toLowerCase();
    if (!name || name.length > HANDLE_MAX_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new Error("name must be a lowercase handle using letters, digits, and hyphens");
    const displayName = bounded(input.displayName, "displayName", DISPLAY_NAME_MAX_LENGTH);
    if (!displayName) throw new Error("displayName is required");
    if (!providers.has(input.provider)) throw new Error("provider is not supported");
    if (!input.computerId) throw new Error("computer is required");
    const runtimeConfig = {
      provider: input.provider,
      model: bounded(input.model, "model", CONFIG_VALUE_MAX_LENGTH),
      modelProvider: bounded(input.modelProvider, "modelProvider", CONFIG_VALUE_MAX_LENGTH),
      reasoning: bounded(input.reasoning, "reasoning", CONFIG_VALUE_MAX_LENGTH),
    };
    if (!(await this.availability.canRun(principal.workspaceId, input.computerId, runtimeConfig)))
      throw new Error("runtime selection is not available on the selected Computer");
    const agent = await this.agents.create({
      workspaceId: principal.workspaceId,
      ownerId: principal.userId,
      name,
      displayName,
      computerId: input.computerId,
      runtimeConfig,
    });
    try {
      await this.starter.start(
        {
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId: agent.workspaceId,
          computerId: agent.computerId,
          agentId: agent.id,
          ...runtimeConfig,
        },
        principal.userId,
      );
      return { agent, startPublished: true as const };
    } catch {
      return { agent, startPublished: false as const };
    }
  }
}

export function readRuntimeConfig(agent: AgentRecord) {
  return agent.runtimeConfig;
}
