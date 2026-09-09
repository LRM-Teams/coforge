import {
  RUNTIME_PROVIDER,
  type AgentStartIntent,
  type AgentStopIntent,
  type RuntimeProvider,
} from "@coforge/protocol";
import type { AgentRecord, AgentRepository } from "../db/repositories/agent.repositories.server";
import { publicAgentRuntimeConfig } from "./agent-runtime-config.server";
import type { AgentRuntimeCredentials } from "./agent-runtime-credentials.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";

const providers = new Set<unknown>(Object.values(RUNTIME_PROVIDER));

export type AgentCreateInput = {
  name: string;
  description: string;
  provider: RuntimeProvider;
  model?: string;
  modelProvider?: string;
  reasoning?: string;
  computerId: string;
  apiKey?: string;
};

type AgentPrincipal = { userId: string; workspaceId: string };
type AgentRuntimeControl = {
  start(intent: AgentStartIntent, userId: string): Promise<void>;
  stop(intent: AgentStopIntent, userId: string): Promise<void>;
};
type RuntimeAvailability = {
  canRun(
    workspaceId: string,
    userId: string,
    computerId: string,
    config: {
      provider: RuntimeProvider;
      model: string;
      modelProvider: string;
      reasoning: string;
      hasApiKey: boolean;
    },
  ): Promise<boolean>;
};

export class ManageAgents {
  constructor(
    private readonly agents: AgentRepository,
    private readonly runtimeControl: AgentRuntimeControl,
    private readonly availability: RuntimeAvailability,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly credentials?: () => Pick<AgentRuntimeCredentials, "encrypt">,
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
    const apiKeyInput = input.apiKey?.trim();
    const selection = {
      provider: input.provider,
      model: input.model?.trim() ?? "",
      modelProvider: input.modelProvider?.trim() ?? "",
      reasoning: input.reasoning?.trim() ?? "",
      hasApiKey: Boolean(apiKeyInput),
    };
    if (selection.provider === RUNTIME_PROVIDER.COFORGE && !apiKeyInput)
      throw new Error("API key is required for CoForge");
    if (
      !(await this.availability.canRun(
        principal.workspaceId,
        principal.userId,
        input.computerId,
        selection,
      ))
    )
      throw new Error("runtime selection is not available on the selected Computer");
    const agentId = crypto.randomUUID();
    const encryptedApiKey = apiKeyInput
      ? await this.#encrypt(agentId, selection.modelProvider, apiKeyInput)
      : undefined;
    const storedProvider =
      selection.modelProvider &&
      (selection.provider === RUNTIME_PROVIDER.COFORGE || encryptedApiKey)
        ? {
            kind: "coforge" as const,
            providerId: selection.modelProvider,
            ...(encryptedApiKey ? { apiKey: encryptedApiKey } : {}),
          }
        : { kind: "default" as const };
    const agent = await this.agents.create({
      id: agentId,
      workspaceId: principal.workspaceId,
      ownerId: principal.userId,
      name,
      displayName: name,
      description,
      computerId: input.computerId,
      runtimeConfig: {
        runtime: selection.provider,
        provider: storedProvider,
        model: selection.model,
        modelProvider: selection.modelProvider,
        reasoning: selection.reasoning,
      },
    });
    try {
      await this.runtimeControl.start(
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
      return { agent: publicAgent(agent), startPublished: true as const };
    } catch {
      return { agent: publicAgent(agent), startPublished: false as const };
    }
  }

  async update(
    principal: AgentPrincipal,
    input: Omit<AgentCreateInput, "computerId"> & { agentId: string },
  ) {
    return this.runtimeLock.run(input.agentId, async () => {
      const current = await this.agents.getById(input.agentId);
      if (
        !current ||
        current.workspaceId !== principal.workspaceId ||
        current.ownerId !== principal.userId ||
        !current.computerId
      )
        throw new Error("Agent is not authorized");
      const name = input.name.trim().toLowerCase();
      if (!name) throw new Error("name is required");
      if (!providers.has(input.provider)) throw new Error("provider is not supported");
      const apiKeyInput = input.apiKey?.trim();
      const selection = {
        provider: input.provider,
        model: input.model?.trim() ?? "",
        modelProvider: input.modelProvider?.trim() ?? "",
        reasoning: input.reasoning?.trim() ?? "",
      };
      const sameProvider =
        current.runtimeConfig.provider.kind === "coforge" &&
        current.runtimeConfig.runtime === selection.provider &&
        current.runtimeConfig.provider.providerId === selection.modelProvider;
      const preservedApiKey =
        sameProvider && current.runtimeConfig.provider.kind === "coforge"
          ? current.runtimeConfig.provider.apiKey
          : undefined;
      const encryptedApiKey = apiKeyInput
        ? await this.#encrypt(current.id, selection.modelProvider, apiKeyInput)
        : undefined;
      const apiKey = encryptedApiKey ?? preservedApiKey;
      if (selection.provider === RUNTIME_PROVIDER.COFORGE && !apiKey)
        throw new Error("API key is required for CoForge");
      const runtimeConfig: AgentRecord["runtimeConfig"] = {
        runtime: selection.provider,
        provider:
          selection.modelProvider && (selection.provider === RUNTIME_PROVIDER.COFORGE || apiKey)
            ? {
                kind: "coforge",
                providerId: selection.modelProvider,
                ...(apiKey ? { apiKey } : {}),
              }
            : { kind: "default" },
        model: selection.model,
        modelProvider: selection.modelProvider,
        reasoning: selection.reasoning,
      };
      const runtimeChanged =
        JSON.stringify(current.runtimeConfig) !== JSON.stringify(runtimeConfig);
      if (
        runtimeChanged &&
        !(await this.availability.canRun(
          principal.workspaceId,
          principal.userId,
          current.computerId,
          { ...selection, hasApiKey: Boolean(apiKey) },
        ))
      )
        throw new Error("runtime selection is not available on the selected Computer");
      if (runtimeChanged)
        await this.runtimeControl.stop(
          {
            protocolMajor: 1,
            requestId: crypto.randomUUID(),
            workspaceId: current.workspaceId,
            computerId: current.computerId,
            agentId: current.id,
          },
          principal.userId,
        );
      const metadata = {
        name,
        displayName: name,
        description: input.description.trim(),
      };
      const agent = await this.agents.update(
        current.id,
        runtimeChanged ? { ...metadata, runtimeConfig } : metadata,
      );
      if (!runtimeChanged) return { agent: publicAgent(agent), restart: "not-required" as const };
      try {
        await this.runtimeControl.start(
          {
            protocolMajor: 1,
            requestId: crypto.randomUUID(),
            workspaceId: agent.workspaceId,
            computerId: current.computerId,
            agentId: agent.id,
            ...runtimeStartFields(agent.runtimeConfig),
          },
          principal.userId,
        );
        return { agent: publicAgent(agent), restart: "published" as const };
      } catch {
        return { agent: publicAgent(agent), restart: "deferred" as const };
      }
    });
  }

  async #encrypt(agentId: string, providerId: string, apiKey: string) {
    if (!providerId) throw new Error("model provider is required for an API key");
    if (!this.credentials) throw new Error("Agent runtime credential encryption is unavailable");
    return this.credentials().encrypt(agentId, providerId, apiKey);
  }
}

function publicAgent(agent: AgentRecord): AgentRecord {
  return { ...agent, runtimeConfig: publicAgentRuntimeConfig(agent.runtimeConfig) };
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
