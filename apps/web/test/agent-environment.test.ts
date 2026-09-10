import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import {
  AgentEnvironment,
  decryptAgentEnvironment,
  validateAgentEnvironment,
} from "../src/server/agents/agent-environment.server";
import { publicAgentRuntimeConfig } from "../src/server/agents/agent-runtime-config.server";
import type { AgentRecord } from "../src/server/db/repositories/agent.repositories.server";

const principal = { workspaceId: "workspace-1", userId: "owner-1" };
function fixture(
  options: { writeFails?: boolean; startFails?: boolean; stopFails?: boolean } = {},
) {
  const events: string[] = [];
  const starts: unknown[] = [];
  const agent: AgentRecord = {
    id: "agent-1",
    workspaceId: principal.workspaceId,
    ownerId: principal.userId,
    computerId: "computer-1",
    name: "builder",
    displayName: "Builder",
    createdAt: new Date(),
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.PI,
      provider: { kind: "default" },
      model: "model",
      modelProvider: "provider",
      reasoning: "high",
    },
  };
  const environment = new AgentEnvironment(
    {
      findOwnedAgent: async (id, workspaceId, ownerId) =>
        id === agent.id && workspaceId === agent.workspaceId && ownerId === agent.ownerId
          ? agent
          : undefined,
      updateRuntimeConfig: async (_id, config) => {
        events.push("write");
        if (options.writeFails) throw new Error("storage contains sensitive details");
        agent.runtimeConfig = config;
      },
    },
    { getById: async (id) => (id === agent.id ? agent : undefined) },
    {
      stop: async () => {
        events.push("stop");
        if (options.stopFails) throw new Error("stop failed");
      },
      start: async (intent) => {
        events.push("start");
        starts.push(intent);
        if (options.startFails) throw new Error("start failed");
      },
    },
    {
      run: async (_id, callback) => {
        events.push("lock");
        try {
          return await callback();
        } finally {
          events.push("unlock");
        }
      },
    },
    new Uint8Array(32).fill(7),
  );
  return { environment, agent, events, starts };
}

test("failed environment persistence restores the original runtime and hides storage errors", async () => {
  const f = fixture({ writeFails: true, startFails: true });
  await expect(f.environment.save(principal, "agent-1", { API_TOKEN: "secret" })).rejects.toThrow(
    "Agent environment could not be saved",
  );
  expect(f.events).toEqual(["lock", "stop", "write", "start", "unlock"]);
  expect(f.starts[0]).toMatchObject({ model: "model", provider: RUNTIME_PROVIDER.PI });
  expect(f.agent.runtimeConfig.environment).toBeUndefined();
});

test("only explicit overrides round trip encrypted; empty clears; start/WSS and public config omit secrets", async () => {
  const f = fixture();
  const envVars = {
    OPENROUTER_API_KEY: "secret-one",
    HTTPS_PROXY: "https://proxy",
    EMPTY: "",
  };
  expect(await f.environment.get(principal, "agent-1")).toEqual({});
  expect(await f.environment.save(principal, "agent-1", envVars)).toEqual({ restart: "published" });
  expect(await f.environment.get(principal, "agent-1")).toEqual(envVars);
  expect(await f.environment.launchEnvironment("agent-1", f.agent.runtimeConfig)).toEqual(envVars);
  const first = f.agent.runtimeConfig.environment!;
  expect(JSON.stringify(f.agent.runtimeConfig)).not.toContain("secret-one");
  expect(publicAgentRuntimeConfig(f.agent.runtimeConfig)).not.toHaveProperty("environment");
  expect(JSON.stringify(f.starts)).not.toContain(first.ciphertext);
  expect(JSON.stringify(f.starts)).not.toContain("secret-one");
  await f.environment.save(principal, "agent-1", envVars);
  expect(f.agent.runtimeConfig.environment!.nonce).not.toBe(first.nonce);
  await f.environment.save(principal, "agent-1", {});
  expect(f.agent.runtimeConfig.environment).toBeUndefined();
  expect(await f.environment.get(principal, "agent-1")).toEqual({});
});

test("owner and workspace authorize both reads and writes before control", async () => {
  for (const denied of [
    { ...principal, userId: "other" },
    { ...principal, workspaceId: "other" },
  ]) {
    const f = fixture();
    await expect(f.environment.get(denied, "agent-1")).rejects.toThrow();
    await expect(f.environment.save(denied, "agent-1", { TOKEN: "secret" })).rejects.toThrow();
    expect(f.events).toEqual(["lock", "unlock"]);
  }
});

test("tampered ciphertext, nonce, wrong key and cross-Agent replay fail with safe errors", async () => {
  const f = fixture();
  await f.environment.save(principal, "agent-1", { TOKEN: "unique-secret" });
  const original = f.agent.runtimeConfig;
  for (const environment of [
    { ...original.environment!, ciphertext: "AAAA" },
    { ...original.environment!, nonce: "AAAA" },
    { ...original.environment!, keyId: "other" },
  ]) {
    await expect(
      f.environment.launchEnvironment("agent-1", { ...original, environment }),
    ).rejects.toThrow("Agent environment could not be decrypted");
  }
  await expect(f.environment.launchEnvironment("other-agent", original)).rejects.toThrow(
    "Agent environment could not be decrypted",
  );
  await expect(
    decryptAgentEnvironment("agent-1", original.environment, new Uint8Array(32).fill(8)),
  ).rejects.toThrow("Agent environment could not be decrypted");
  await expect(decryptAgentEnvironment("agent-1", original.environment, undefined)).rejects.toThrow(
    "Agent environment could not be decrypted",
  );
});

test("invalid maps fail before stop and never echo values", async () => {
  for (const input of [
    null,
    [],
    "secret",
    { PATH: "secret" },
    { coforge_API_KEY: "secret" },
    { "BAD=NAME": "secret" },
    { A: "secret\0" },
    { A: 123 },
    { A: "s".repeat(32769) },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`A${i}`, "s"])),
    { A: "s".repeat(32768), B: "s".repeat(32768), C: "s".repeat(32768), D: "s".repeat(32768) },
  ]) {
    expect(() => validateAgentEnvironment(input)).toThrow();
  }
  const f = fixture();
  await expect(f.environment.save(principal, "agent-1", { PATH: "secret" })).rejects.toThrow(
    "reserved variable name",
  );
  expect(f.events).toEqual(["lock", "unlock"]);
  expect(
    validateAgentEnvironment(JSON.parse('{"__proto__":"literal","constructor":"value"}')),
  ).toEqual(JSON.parse('{"__proto__":"literal","constructor":"value"}'));
  expect(validateAgentEnvironment({ ["A".repeat(128)]: "s".repeat(32768) })).toEqual({
    ["A".repeat(128)]: "s".repeat(32768),
  });
  expect(() => validateAgentEnvironment({ ["A".repeat(129)]: "s" })).toThrow();
  expect(
    Object.keys(
      validateAgentEnvironment(
        Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`A${i}`, "s"])),
      ),
    ),
  ).toHaveLength(64);
});

test("stop failure prevents writes; start failure retains saved settings with deferred restart", async () => {
  const stopped = fixture({ stopFails: true });
  await expect(stopped.environment.save(principal, "agent-1", { TOKEN: "secret" })).rejects.toThrow(
    "stop failed",
  );
  expect(stopped.events).toEqual(["lock", "stop", "unlock"]);
  const deferred = fixture({ startFails: true });
  expect(await deferred.environment.save(principal, "agent-1", { TOKEN: "secret" })).toEqual({
    restart: "deferred",
  });
  expect(await deferred.environment.get(principal, "agent-1")).toEqual({ TOKEN: "secret" });
});
