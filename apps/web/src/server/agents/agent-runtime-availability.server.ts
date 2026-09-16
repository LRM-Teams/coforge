import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

export type AgentRuntimeSelection = {
  provider: RuntimeProvider;
  model: string;
  modelProvider: string;
  reasoning: string;
  hasApiKey: boolean;
};

export function agentRuntimeSelectionIsAvailable(
  config: AgentRuntimeSelection,
  inventory: {
    connected: boolean;
    providers: ReadonlySet<RuntimeProvider>;
    models: readonly unknown[];
  },
): boolean {
  if (!inventory.connected) return false;
  if (!providerIsSelectable(config.provider, inventory.providers)) return false;
  // CoForge/keyed Pi may authorize a provider before the catalog model is chosen.
  if (
    config.modelProvider &&
    (config.provider === RUNTIME_PROVIDER.COFORGE ||
      (config.provider === RUNTIME_PROVIDER.PI && config.hasApiKey))
  )
    return true;
  if (!config.model) return !config.modelProvider && !config.reasoning;
  return inventory.models.some((value) => modelMatches(value, config));
}

function providerIsSelectable(
  provider: RuntimeProvider,
  providers: ReadonlySet<RuntimeProvider>,
): boolean {
  if (providers.has(provider)) return true;
  return provider === RUNTIME_PROVIDER.COFORGE && providers.has(RUNTIME_PROVIDER.PI);
}

function modelMatches(value: unknown, config: AgentRuntimeSelection): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const id = Reflect.get(value, "id");
  const modelProvider = Reflect.get(value, "modelProvider");
  const efforts = Reflect.get(value, "reasoningEfforts");
  return (
    id === config.model &&
    modelProvider === config.modelProvider &&
    (!config.reasoning || (Array.isArray(efforts) && efforts.includes(config.reasoning)))
  );
}
