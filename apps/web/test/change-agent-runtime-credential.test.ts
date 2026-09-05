import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { ChangeAgentRuntimeCredential } from "../src/server/agents/change-agent-runtime-credential.server";
import type { AgentRecord } from "../src/server/db/repositories/agent.repositories.server";

const principal = { workspaceId: "workspace-1", userId: "user-1" };

function fixture(options?: { stopFails?: boolean; mutationFails?: boolean; startFails?: boolean }) {
  const events: string[] = [];
  const starts: unknown[] = [];
  const agent: AgentRecord = {
    id: "agent-1",
    workspaceId: principal.workspaceId,
    ownerId: principal.userId,
    computerId: "computer-1",
    name: "builder",
    displayName: "Builder",
    createdAt: new Date("2026-09-05T00:00:00Z"),
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.COFORGE,
      provider: { kind: "coforge", providerId: "anthropic" },
      model: "claude-sonnet-4-20250514",
      modelProvider: "anthropic",
      reasoning: "high",
    },
  };
  const credentialChange = new ChangeAgentRuntimeCredential(
    { getById: async () => agent },
    {
      save: async () => {
        events.push("save");
        if (options?.mutationFails) throw new Error("credential persistence failed");
        agent.runtimeConfig = {
          ...agent.runtimeConfig,
          provider: {
            kind: "coforge",
            providerId: "anthropic",
            apiKey: { keyId: "v1", ciphertext: "ciphertext", nonce: "nonce", hint: "••••1234" },
          },
        };
        return { providerId: "anthropic", hint: "••••1234" };
      },
      delete: async () => {
        events.push("delete");
        if (options?.mutationFails) throw new Error("credential persistence failed");
      },
    },
    {
      stop: async () => {
        events.push("stop");
        if (options?.stopFails) throw new Error("stop publication failed");
      },
      start: async (intent) => {
        events.push("start");
        starts.push(intent);
        if (options?.startFails) throw new Error("start publication failed");
      },
    },
    { run: async (_agentId, callback) => callback() },
  );
  return { credentialChange, events, starts };
}

describe("ChangeAgentRuntimeCredential", () => {
  test("stops, saves the credential, then starts with the updated runtime configuration", async () => {
    const { credentialChange, events, starts } = fixture();

    const result = await credentialChange.save(principal, "agent-1", "sk-secret-value-1234");

    expect(events).toEqual(["stop", "save", "start"]);
    expect(result).toEqual({
      result: { providerId: "anthropic", hint: "••••1234" },
      restart: "published",
    });
    expect(starts[0]).toMatchObject({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      provider: RUNTIME_PROVIDER.COFORGE,
      model: "claude-sonnet-4-20250514",
    });
  });

  test("stops, deletes the credential, then starts", async () => {
    const { credentialChange, events } = fixture();

    await credentialChange.delete(principal, "agent-1");

    expect(events).toEqual(["stop", "delete", "start"]);
  });

  test("does not mutate the credential when stop publication fails", async () => {
    const { credentialChange, events } = fixture({ stopFails: true });

    await expect(
      credentialChange.save(principal, "agent-1", "sk-secret-value-1234"),
    ).rejects.toThrow("stop publication failed");
    expect(events).toEqual(["stop"]);
  });

  test("best-effort restarts the old runtime configuration when credential mutation fails", async () => {
    const { credentialChange, events, starts } = fixture({
      mutationFails: true,
      startFails: true,
    });

    await expect(credentialChange.delete(principal, "agent-1")).rejects.toThrow(
      "credential persistence failed",
    );
    expect(events).toEqual(["stop", "delete", "start"]);
    expect(starts[0]).toMatchObject({
      provider: RUNTIME_PROVIDER.COFORGE,
      providerConfig: { kind: "coforge", providerId: "anthropic" },
      model: "claude-sonnet-4-20250514",
    });
  });

  test("keeps the saved mutation and reports deferred when start publication fails", async () => {
    const { credentialChange, events } = fixture({ startFails: true });

    const result = await credentialChange.save(principal, "agent-1", "sk-secret-value-1234");

    expect(events).toEqual(["stop", "save", "start"]);
    expect(result.restart).toBe("deferred");
    expect(result.result).toEqual({ providerId: "anthropic", hint: "••••1234" });
  });
});
