import { RUNTIME_PROVIDER, type AgentStartIntent, type RuntimeProvider } from "@coforge/protocol";
import type { AgentRecord, AgentRepository } from "../db/repositories/agent.repositories.server";
import { publicAgentRuntimeConfig } from "./agent-runtime-config.server";

const providers = new Set<unknown>(Object.values(RUNTIME_PROVIDER));

export type AgentCreateInput = {
  name: string;
  description: string;
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
    if (!name) throw new Error("name is required");
    const description = input.description.trim();
    if (!providers.has(input.provider)) throw new Error("provider is not supported");
    if (!input.computerId) throw new Error("computer is required");
    const selection = {
      provider: input.provider,
      model: input.model?.trim() ?? "",
      modelProvider: input.modelProvider?.trim() ?? "",
      reasoning: input.reasoning?.trim() ?? "",
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
      displayName: name,
      description,
      computerId: input.computerId,
      runtimeConfig: {
        runtime: selection.provider,
        provider:
          selection.provider === RUNTIME_PROVIDER.COFORGE && selection.modelProvider
            ? {
                kind: "coforge" as const,
                providerId: selection.modelProvider,
              }
            : { kind: "default" as const },
        model: selection.model,
        modelProvider: selection.modelProvider,
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
          agent.runtimeConfig.provider.kind === "coforge"
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
    config.provider.kind === "coforge"
      ? { kind: config.provider.kind, providerId: config.provider.providerId }
      : config.provider;
  return {
    provider: config.runtime,
    model: config.model,
    modelProvider: config.modelProvider,
    reasoning: config.reasoning,
    providerConfig: launchProviderConfig,
  };
}
