import type { AgentStartIntent, AgentStopIntent } from "@coforge/protocol";
import type { AgentRecord } from "../db/repositories/agent.repositories.server";
import type { AgentRuntimeConfig, EncryptedAgentEnvironment } from "./agent-runtime-config.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import { runtimeStartFields } from "./manage-agents.server";

const MAX_VARIABLES = 64;
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 32_768;
const MAX_SERIALIZED_LENGTH = 131_072;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_ID = "v1";
const NONCE_BYTES = 12;
const AAD_PREFIX = "coforge.agent-environment.v1";

type Principal = { workspaceId: string; userId: string };

export type AgentEnvironmentRepository = {
  findOwnedAgent(
    agentId: string,
    workspaceId: string,
    ownerId: string,
  ): Promise<{ runtimeConfig: AgentRuntimeConfig } | undefined>;
  updateRuntimeConfig(agentId: string, runtimeConfig: AgentRuntimeConfig): Promise<void>;
};

type AgentLookup = { getById(agentId: string): Promise<AgentRecord | undefined> };
type RuntimeControl = {
  start(intent: AgentStartIntent, userId: string): Promise<void>;
  stop(intent: AgentStopIntent, userId: string): Promise<void>;
};

export class AgentEnvironment {
  constructor(
    private readonly repository: AgentEnvironmentRepository,
    private readonly agents: AgentLookup,
    private readonly runtimeControl: RuntimeControl,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly encryptionKey: Uint8Array<ArrayBuffer>,
  ) {
    if (encryptionKey.byteLength !== 32)
      throw new Error("Agent environment encryption key must be 32 bytes");
  }

  async get(principal: Principal, agentId: string): Promise<Record<string, string>> {
    const config = await this.#ownedConfig(principal, agentId);
    return config.environment ? this.#decrypt(agentId, config.environment) : {};
  }

  save(
    principal: Principal,
    agentId: string,
    input: Record<string, string>,
  ): Promise<{ restart: "published" | "deferred" }> {
    return this.runtimeLock.run(agentId, async () => {
      const agent = await this.agents.getById(agentId);
      if (
        !agent?.computerId ||
        agent.workspaceId !== principal.workspaceId ||
        agent.ownerId !== principal.userId
      )
        throw new Error("Agent is not authorized");
      const envVars = validateAgentEnvironment(input);
      const config = await this.#ownedConfig(principal, agentId);
      await this.runtimeControl.stop(stopIntent(agent), principal.userId);
      const { environment: _environment, ...withoutEnvironment } = config;
      try {
        await this.repository.updateRuntimeConfig(
          agentId,
          Object.keys(envVars).length
            ? { ...withoutEnvironment, environment: await this.#encrypt(agentId, envVars) }
            : withoutEnvironment,
        );
      } catch {
        try {
          await this.runtimeControl.start(startIntent(agent), principal.userId);
        } catch {}
        throw new Error("Agent environment could not be saved");
      }
      try {
        const updated = await this.agents.getById(agentId);
        if (!updated?.computerId) return { restart: "deferred" };
        await this.runtimeControl.start(startIntent(updated), principal.userId);
        return { restart: "published" };
      } catch {
        return { restart: "deferred" };
      }
    });
  }

  async launchEnvironment(agentId: string, config: AgentRuntimeConfig) {
    return config.environment ? this.#decrypt(agentId, config.environment) : {};
  }

  async #ownedConfig(principal: Principal, agentId: string) {
    const agent = await this.repository.findOwnedAgent(
      agentId,
      principal.workspaceId,
      principal.userId,
    );
    if (!agent) throw new Error("Agent environment is not available");
    return agent.runtimeConfig;
  }

  async #encrypt(agentId: string, envVars: Record<string, string>) {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(agentId) },
      await this.#key(["encrypt"]),
      new TextEncoder().encode(JSON.stringify(envVars)),
    );
    return {
      keyId: KEY_ID,
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
    };
  }

  async #decrypt(agentId: string, encrypted: EncryptedAgentEnvironment) {
    return decryptAgentEnvironment(agentId, encrypted, this.encryptionKey);
  }

  #key(usages: KeyUsage[]) {
    return crypto.subtle.importKey("raw", this.encryptionKey, "AES-GCM", false, usages);
  }
}

export async function decryptAgentEnvironment(
  agentId: string,
  encrypted: EncryptedAgentEnvironment | undefined,
  encryptionKey: Uint8Array<ArrayBuffer> | undefined,
): Promise<Record<string, string>> {
  if (!encrypted) return {};
  try {
    if (encrypted.keyId !== KEY_ID || !encryptionKey) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(encrypted.nonce, "base64"), additionalData: aad(agentId) },
      await crypto.subtle.importKey("raw", encryptionKey, "AES-GCM", false, ["decrypt"]),
      Buffer.from(encrypted.ciphertext, "base64"),
    );
    return validateAgentEnvironment(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error("Agent environment could not be decrypted");
  }
}

export function validateAgentEnvironment(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Agent environment must be a variable map");
  const entries = Object.entries(input);
  if (entries.length > MAX_VARIABLES) throw new Error("Agent environment has too many variables");
  const envVars: Record<string, string> = Object.create(null);
  for (const [name, value] of entries) {
    const upper = name.toUpperCase();
    if (!NAME.test(name) || name.length > MAX_NAME_LENGTH)
      throw new Error("Agent environment contains an invalid variable name");
    if (upper === "PATH" || upper.startsWith("COFORGE_"))
      throw new Error("Agent environment contains a reserved variable name");
    if (typeof value !== "string" || value.includes("\0") || value.length > MAX_VALUE_LENGTH)
      throw new Error("Agent environment contains an invalid variable value");
    envVars[name] = value;
  }
  if (JSON.stringify(envVars).length > MAX_SERIALIZED_LENGTH)
    throw new Error("Agent environment is too large");
  return envVars;
}

function aad(agentId: string) {
  return new TextEncoder().encode(`${AAD_PREFIX}\0${agentId}`);
}

function stopIntent(agent: AgentRecord): AgentStopIntent {
  return {
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: agent.workspaceId,
    computerId: agent.computerId!,
    agentId: agent.id,
  };
}

function startIntent(agent: AgentRecord): AgentStartIntent {
  return { ...stopIntent(agent), ...runtimeStartFields(agent.runtimeConfig) };
}
