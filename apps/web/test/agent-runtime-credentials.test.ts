import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "../src/server/agents/agent-runtime-config.server";
import {
  AgentRuntimeCredentials,
  readAgentRuntimeCredentialEncryptionKey,
  type AgentRuntimeCredentialRepository,
} from "../src/server/agents/agent-runtime-credentials.server";

class MemoryAgentRuntimeCredentialRepository implements AgentRuntimeCredentialRepository {
  readonly agents = new Map<
    string,
    { workspaceId: string; ownerId: string; runtimeConfig: AgentRuntimeConfig }
  >();

  findOwnedAgent(agentId: string, workspaceId: string, ownerId: string) {
    const agent = this.agents.get(agentId);
    return Promise.resolve(
      agent?.workspaceId === workspaceId && agent.ownerId === ownerId ? agent : undefined,
    );
  }

  updateRuntimeConfig(agentId: string, runtimeConfig: AgentRuntimeConfig) {
    const agent = this.agents.get(agentId);
    if (agent) agent.runtimeConfig = runtimeConfig;
    return Promise.resolve();
  }
}

const encryptionKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const principal = { workspaceId: "workspace-1", userId: "user-1" };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Agent runtime credentials", () => {
  test("encrypts the API key inside the owned Agent's runtime config JSON", async () => {
    const repository = repositoryWith({
      runtime: "pi",
      provider: { kind: "pi-builtin", providerId: "deepseek" },
      model: "deepseek-chat",
      reasoning: "high",
    });
    const credentials = new AgentRuntimeCredentials(repository, encryptionKey);

    const summary = await credentials.save(principal, "agent-1", "sk-secret-value-1234");

    expect(summary).toEqual({ providerId: "deepseek", hint: "••••1234" });
    expect(await credentials.summary(principal, "agent-1")).toEqual(summary);
    const stored = repository.agents.get("agent-1")!.runtimeConfig;
    expect(JSON.stringify(stored)).not.toContain("sk-secret-value-1234");
    expect(stored.provider).toMatchObject({
      kind: "pi-builtin",
      providerId: "deepseek",
      apiKey: { keyId: "v1", hint: "••••1234" },
    });
    await expect(credentials.launchProviderConfig("agent-1", stored)).resolves.toEqual({
      kind: "pi-builtin",
      providerId: "deepseek",
      apiKey: "sk-secret-value-1234",
    });
  });

  test("rejects another user and a runtime provider config without an API key", async () => {
    const repository = repositoryWith({
      runtime: "codex",
      provider: { kind: "default" },
      model: "gpt-5",
      reasoning: "high",
    });
    const credentials = new AgentRuntimeCredentials(repository, encryptionKey);

    await expect(credentials.save(principal, "agent-1", "sk-secret-value")).rejects.toThrow(
      "does not accept an API key",
    );
    await expect(
      credentials.save({ ...principal, userId: "user-2" }, "agent-1", "sk-secret-value"),
    ).rejects.toThrow("Agent runtime credential is not available");
  });
});

describe("Agent runtime credential encryption key configuration", () => {
  test("reads a 32-byte hexadecimal key from a mounted secret file", () => {
    const directory = mkdtempSync(join(tmpdir(), "coforge-runtime-key-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "credential-key");
    writeFileSync(path, `${"ab".repeat(32)}\n`, { mode: 0o600 });

    const key = readAgentRuntimeCredentialEncryptionKey({
      COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY_FILE: path,
    });

    expect(key).toEqual(Uint8Array.from({ length: 32 }, () => 0xab));
  });

  test("rejects ambiguous inline and file configuration", () => {
    expect(() =>
      readAgentRuntimeCredentialEncryptionKey({
        COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32),
        COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY_FILE: "/run/secrets/credential-key",
      }),
    ).toThrow("cannot both be set");
  });
});

function repositoryWith(runtimeConfig: AgentRuntimeConfig) {
  const repository = new MemoryAgentRuntimeCredentialRepository();
  repository.agents.set("agent-1", {
    workspaceId: principal.workspaceId,
    ownerId: principal.userId,
    runtimeConfig,
  });
  return repository;
}
