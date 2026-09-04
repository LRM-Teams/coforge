import { RUNTIME_PROVIDER, type AgentStartIntent, type RuntimeProvider } from "@coforge/protocol";
import type { AgentRecord, AgentRepository } from "../db/repositories/agent.repositories.server";
import { publicAgentRuntimeConfig } from "./agent-runtime-config.server";

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
    userId: string,
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
    return this.agents
      .listOwnedInWorkspace(principal.workspaceId, principal.userId)
      .then((agents) =>
        agents.map((agent) => ({
          ...agent,
          runtimeConfig: publicAgentRuntimeConfig(agent.runtimeConfig),
        })),
      );
  }

  async create(principal: AgentPrincipal, input: AgentCreateInput) {
    const name = input.name.trim().toLowerCase();
    if (!name || name.length > HANDLE_MAX_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new Error("name must be a lowercase handle using letters, digits, and hyphens");
    const displayName = bounded(input.displayName, "displayName", DISPLAY_NAME_MAX_LENGTH);
    if (!displayName) throw new Error("displayName is required");
    if (!providers.has(input.provider)) throw new Error("provider is not supported");
    if (!input.computerId) throw new Error("computer is required");
    const selection = {
      provider: input.provider,
      model: bounded(input.model, "model", CONFIG_VALUE_MAX_LENGTH),
      modelProvider: bounded(input.modelProvider, "modelProvider", CONFIG_VALUE_MAX_LENGTH),
      reasoning: bounded(input.reasoning, "reasoning", CONFIG_VALUE_MAX_LENGTH),
    };
    if (
      !(await this.availability.canRun(
        principal.workspaceId,
        principal.userId,
        input.computerId,
        selection,
      ))
    )
      throw new Error("runtime selection is not available on the selected Computer");
    const agent = await this.agents.create({
      workspaceId: principal.workspaceId,
      ownerId: principal.userId,
      name,
      displayName,
      computerId: input.computerId,
      runtimeConfig: {
        runtime: selection.provider,
        provider: selection.modelProvider
          ? {
              kind: "pi-builtin" as const,
              providerId: selection.modelProvider,
            }
          : { kind: "default" as const },
        model: selection.model,
        reasoning: selection.reasoning,
      },
    });
    try {
      await this.starter.start(
        {
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId: agent.workspaceId,
          computerId: input.computerId,
          agentId: agent.id,
          ...runtimeStartFields(agent.runtimeConfig),
        },
        principal.userId,
      );
      return { agent, startPublished: true as const };
    } catch {
      return { agent, startPublished: false as const };
    }
  }

  async retryStart(principal: AgentPrincipal, agentId: string): Promise<void> {
    const agent = await this.agents.getById(agentId);
    if (
      !agent ||
      agent.workspaceId !== principal.workspaceId ||
      agent.ownerId !== principal.userId ||
      !agent.computerId
    )
      throw new Error("Agent is not authorized");
    if (
      !(await this.availability.canRun(principal.workspaceId, principal.userId, agent.computerId, {
        provider: agent.runtimeConfig.runtime,
        model: agent.runtimeConfig.model,
        modelProvider:
          agent.runtimeConfig.provider.kind === "pi-builtin"
            ? agent.runtimeConfig.provider.providerId
            : "",
        reasoning: agent.runtimeConfig.reasoning,
      }))
    )
      throw new Error("runtime selection is not available on the selected Computer");
    await this.starter.start(
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: agent.workspaceId,
        computerId: agent.computerId,
        agentId: agent.id,
        ...runtimeStartFields(agent.runtimeConfig),
      },
      principal.userId,
    );
  }
}

export function runtimeStartFields(config: AgentRecord["runtimeConfig"]) {
  const launchProviderConfig =
    config.provider.kind === "pi-builtin"
      ? { kind: config.provider.kind, providerId: config.provider.providerId }
      : config.provider;
  return {
    provider: config.runtime,
    model: config.model,
    modelProvider:
      "providerId" in launchProviderConfig ? (launchProviderConfig.providerId ?? "") : "",
    reasoning: config.reasoning,
    providerConfig: launchProviderConfig,
  };
}
