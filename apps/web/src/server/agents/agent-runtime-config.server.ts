import { RUNTIME_PROVIDER, type RuntimeProvider } from "@coforge/protocol";

export type EncryptedRuntimeApiKey = {
  keyId: string;
  ciphertext: string;
  nonce: string;
  hint: string;
};

export type AgentRuntimeProviderConfig =
  | { kind: "default" }
  | {
      kind: "pi-builtin";
      providerId: string;
      apiKey?: EncryptedRuntimeApiKey;
    };

export type AgentRuntimeConfig = {
  runtime: RuntimeProvider;
  provider: AgentRuntimeProviderConfig;
  model: string;
  reasoning: string;
};

export function parseAgentRuntimeConfig(value: unknown): AgentRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid runtime config");
  const runtime = runtimeProvider(Reflect.get(value, "runtime"));
  const model = Reflect.get(value, "model");
  const reasoning = Reflect.get(value, "reasoning");
  if (!runtime || typeof model !== "string" || typeof reasoning !== "string")
    throw new Error("invalid runtime config");
  return {
    runtime,
    provider: parseProviderConfig(Reflect.get(value, "provider")),
    model,
    reasoning,
  };
}

export function publicAgentRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    ...config,
    provider:
      config.provider.kind === "pi-builtin"
        ? {
            kind: config.provider.kind,
            providerId: config.provider.providerId,
          }
        : config.provider,
  };
}

function parseProviderConfig(value: unknown): AgentRuntimeProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid runtime provider config");
  const kind = Reflect.get(value, "kind");
  if (kind === "default") return { kind };
  const providerId = Reflect.get(value, "providerId");
  if (kind !== "pi-builtin" || typeof providerId !== "string" || !providerId)
    throw new Error("invalid runtime provider config");
  const apiKey = parseEncryptedApiKey(Reflect.get(value, "apiKey"));
  return { kind, providerId, ...(apiKey ? { apiKey } : {}) };
}

function parseEncryptedApiKey(value: unknown): EncryptedRuntimeApiKey | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid encrypted runtime API key");
  const keyId = Reflect.get(value, "keyId");
  const ciphertext = Reflect.get(value, "ciphertext");
  const nonce = Reflect.get(value, "nonce");
  const hint = Reflect.get(value, "hint");
  if (
    typeof keyId !== "string" ||
    typeof ciphertext !== "string" ||
    typeof nonce !== "string" ||
    typeof hint !== "string"
  )
    throw new Error("invalid encrypted runtime API key");
  return { keyId, ciphertext, nonce, hint };
}

function runtimeProvider(value: unknown): RuntimeProvider | undefined {
  if (value === RUNTIME_PROVIDER.PI) return RUNTIME_PROVIDER.PI;
  if (value === RUNTIME_PROVIDER.CODEX) return RUNTIME_PROVIDER.CODEX;
  if (value === RUNTIME_PROVIDER.CLAUDE_CODE) return RUNTIME_PROVIDER.CLAUDE_CODE;
  return undefined;
}
