import { readFileSync } from "node:fs";
import type { AgentRuntimeConfig, EncryptedRuntimeApiKey } from "./agent-runtime-config.server";

const API_KEY_MIN_LENGTH = 8;
const API_KEY_MAX_LENGTH = 4096;
const ENCRYPTION_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const KEY_ID = "v1";
const ENCRYPTION_KEY_ENV = "COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY";

type AgentRuntimeCredentialPrincipal = { workspaceId: string; userId: string };

export type AgentRuntimeCredentialRepository = {
  findOwnedAgent(
    agentId: string,
    workspaceId: string,
    ownerId: string,
  ): Promise<{ runtimeConfig: AgentRuntimeConfig } | undefined>;
  updateRuntimeConfig(agentId: string, runtimeConfig: AgentRuntimeConfig): Promise<void>;
};

export type AgentRuntimeCredentialSummary = {
  providerId: string;
  hint: string;
};

export class AgentRuntimeCredentials {
  constructor(
    private readonly repository: AgentRuntimeCredentialRepository,
    private readonly encryptionKey?: Uint8Array<ArrayBuffer>,
  ) {
    if (encryptionKey && encryptionKey.byteLength !== ENCRYPTION_KEY_BYTES)
      throw new Error("Agent runtime credential encryption key must be 32 bytes");
  }

  async summary(
    principal: AgentRuntimeCredentialPrincipal,
    agentId: string,
  ): Promise<AgentRuntimeCredentialSummary | null> {
    return summary((await this.#ownedConfig(principal, agentId)).provider);
  }

  async save(
    principal: AgentRuntimeCredentialPrincipal,
    agentId: string,
    apiKeyInput: string,
  ): Promise<AgentRuntimeCredentialSummary> {
    const runtimeConfig = await this.#ownedConfig(principal, agentId);
    if (runtimeConfig.provider.kind !== "pi-builtin")
      throw new Error("Agent runtime provider does not accept an API key");
    const apiKey = validateApiKey(apiKeyInput);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: associatedData(agentId, runtimeConfig.provider.providerId),
        },
        await this.#key(["encrypt"]),
        new TextEncoder().encode(apiKey),
      ),
    );
    const encryptedApiKey = {
      keyId: KEY_ID,
      ciphertext: Buffer.from(encrypted).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      hint: `••••${apiKey.slice(-4)}`,
    };
    await this.repository.updateRuntimeConfig(agentId, {
      ...runtimeConfig,
      provider: { ...runtimeConfig.provider, apiKey: encryptedApiKey },
    });
    return { providerId: runtimeConfig.provider.providerId, hint: encryptedApiKey.hint };
  }

  async delete(principal: AgentRuntimeCredentialPrincipal, agentId: string): Promise<void> {
    const runtimeConfig = await this.#ownedConfig(principal, agentId);
    if (runtimeConfig.provider.kind !== "pi-builtin") return;
    const { apiKey: _apiKey, ...provider } = runtimeConfig.provider;
    await this.repository.updateRuntimeConfig(agentId, { ...runtimeConfig, provider });
  }

  async launchProviderConfig(agentId: string, runtimeConfig: AgentRuntimeConfig) {
    if (runtimeConfig.provider.kind !== "pi-builtin") return runtimeConfig.provider;
    const encrypted = runtimeConfig.provider.apiKey;
    if (!encrypted)
      return {
        kind: runtimeConfig.provider.kind,
        providerId: runtimeConfig.provider.providerId,
      };
    const apiKey = await decryptApiKey(
      this.encryptionKey,
      encrypted,
      agentId,
      runtimeConfig.provider.providerId,
    );
    return {
      kind: runtimeConfig.provider.kind,
      providerId: runtimeConfig.provider.providerId,
      apiKey,
    };
  }

  async #ownedConfig(principal: AgentRuntimeCredentialPrincipal, agentId: string) {
    const agent = await this.repository.findOwnedAgent(
      agentId,
      principal.workspaceId,
      principal.userId,
    );
    if (!agent) throw new Error("Agent runtime credential is not available");
    return agent.runtimeConfig;
  }

  #key(keyUsages: KeyUsage[]) {
    if (!this.encryptionKey)
      throw new Error("Agent runtime credential encryption key is unavailable");
    return crypto.subtle.importKey("raw", this.encryptionKey, "AES-GCM", false, keyUsages);
  }
}

export function readAgentRuntimeCredentialEncryptionKey(
  env: NodeJS.ProcessEnv,
): Uint8Array<ArrayBuffer> {
  const inlineValue = env[ENCRYPTION_KEY_ENV]?.trim();
  const fileEnv = `${ENCRYPTION_KEY_ENV}_FILE`;
  const filePath = env[fileEnv]?.trim();
  if (inlineValue && filePath)
    throw new Error(`${ENCRYPTION_KEY_ENV} and ${fileEnv} cannot both be set`);
  let value = inlineValue;
  if (filePath) {
    try {
      value = readFileSync(filePath, "utf8").trim();
    } catch {
      throw new Error(`${fileEnv} could not be read`);
    }
  }
  if (!value) throw new Error(`${ENCRYPTION_KEY_ENV} is required`);
  if (!/^[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`${ENCRYPTION_KEY_ENV} must be 64 hexadecimal characters`);
  return Uint8Array.from({ length: ENCRYPTION_KEY_BYTES }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

export function readOptionalAgentRuntimeCredentialEncryptionKey(
  env: NodeJS.ProcessEnv,
): Uint8Array<ArrayBuffer> | undefined {
  if (!env[ENCRYPTION_KEY_ENV]?.trim() && !env[`${ENCRYPTION_KEY_ENV}_FILE`]?.trim())
    return undefined;
  return readAgentRuntimeCredentialEncryptionKey(env);
}

async function decryptApiKey(
  encryptionKey: Uint8Array<ArrayBuffer> | undefined,
  encrypted: EncryptedRuntimeApiKey,
  agentId: string,
  providerId: string,
) {
  if (!encryptionKey || encrypted.keyId !== KEY_ID)
    throw new Error("Agent runtime credential encryption key is unavailable");
  const key = await crypto.subtle.importKey("raw", encryptionKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(encrypted.nonce, "base64"),
      additionalData: associatedData(agentId, providerId),
    },
    key,
    Buffer.from(encrypted.ciphertext, "base64"),
  );
  return new TextDecoder().decode(plaintext);
}

function validateApiKey(value: string) {
  const apiKey = value.trim();
  if (apiKey.length < API_KEY_MIN_LENGTH) throw new Error("API key must be at least 8 characters");
  if (apiKey.length > API_KEY_MAX_LENGTH) throw new Error("API key is too long");
  return apiKey;
}

function associatedData(agentId: string, providerId: string) {
  return new TextEncoder().encode(`${agentId}\0${providerId}`);
}

function summary(provider: AgentRuntimeConfig["provider"]): AgentRuntimeCredentialSummary | null {
  if (provider.kind !== "pi-builtin" || !provider.apiKey) return null;
  return { providerId: provider.providerId, hint: provider.apiKey.hint };
}
