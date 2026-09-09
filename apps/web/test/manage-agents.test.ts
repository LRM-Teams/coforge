import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { ManageAgents } from "../src/server/agents/manage-agents.server";
import { parseAgentRuntimeConfig } from "../src/server/agents/agent-runtime-config.server";
import type {
  AgentRecord,
  AgentRepository,
} from "../src/server/db/repositories/agent.repositories.server";

function fixture(options?: {
  publishFails?: boolean;
  stopFails?: boolean;
  unavailable?: boolean;
  encryptionFails?: boolean;
}) {
  const records: AgentRecord[] = [];
  const starts: unknown[] = [];
  const controls: string[] = [];
  const selections: Array<{ hasApiKey?: boolean }> = [];
  const updates: Array<Parameters<AgentRepository["update"]>[1]> = [];
  const repository: AgentRepository = {
    getById: async (id) => records.find((agent) => agent.id === id),
    listInWorkspace: async (workspaceId) =>
      records.filter((agent) => agent.workspaceId === workspaceId),
    listForComputer: async (workspaceId, computerId) =>
      records.filter(
        (agent) => agent.workspaceId === workspaceId && agent.computerId === computerId,
      ),
    listOwnedInWorkspace: async (workspaceId, ownerId) =>
      records.filter((agent) => agent.workspaceId === workspaceId && agent.ownerId === ownerId),
    create: async (input) => {
      const record = {
        ...input,
        id: input.id ?? `agent-${records.length + 1}`,
        createdAt: new Date("2026-08-29T00:00:00Z"),
      };
      records.push(record);
      return record;
    },
    update: async (id, input) => {
      updates.push(input);
      controls.push("persist");
      const index = records.findIndex((agent) => agent.id === id);
      records[index] = { ...records[index]!, ...input };
      return records[index]!;
    },
  };
  const agentManagement = new ManageAgents(
    repository,
    {
      start: async (intent, userId) => {
        controls.push("start");
        starts.push({ intent, userId });
        if (options?.publishFails) throw new Error("daemon unavailable");
      },
      stop: async () => {
        controls.push("stop");
        if (options?.stopFails) throw new Error("stop unavailable");
      },
    },
    {
      canRun: async (_workspaceId, _userId, _computerId, selection) => {
        selections.push(selection);
        return !options?.unavailable;
      },
    },
    { run: async (_agentId, callback) => callback() },
    () => ({
      encrypt: async (_agentId, _providerId, apiKey) => {
        if (options?.encryptionFails) throw new Error("encryption unavailable");
        return { keyId: "v1", ciphertext: `encrypted:${apiKey}`, nonce: "nonce", hint: "••••1234" };
      },
    }),
  );
  return { agentManagement, records, starts, controls, updates, selections };
}

describe("ManageAgents", () => {
  test("lists and creates only for the authenticated user's current Workspace", async () => {
    const { agentManagement, records, starts } = fixture();
    records.push({
      id: "other-agent",
      workspaceId: "workspace-1",
      ownerId: "other-user",
      name: "other",
      displayName: "Other",
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.CODEX,
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
      createdAt: new Date(),
    });

    const result = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "  MY-Agent  ",
        description: "Build and release helper",
        provider: RUNTIME_PROVIDER.COFORGE,
        computerId: "computer-1",
        model: " model-a ",
        modelProvider: " anthropic ",
        reasoning: " high ",
        apiKey: "secret-key-1234",
      },
    );

    expect(result.startPublished).toBe(true);
    expect(result.agent).toMatchObject({
      workspaceId: "workspace-1",
      ownerId: "user-1",
      name: "my-agent",
      displayName: "my-agent",
      runtimeConfig: {
        runtime: "coforge",
        provider: { kind: "coforge", providerId: "anthropic" },
        model: "model-a",
        modelProvider: "anthropic",
        reasoning: "high",
      },
    });
    expect(
      await agentManagement.list({
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual([result.agent]);
    expect(starts).toHaveLength(1);
  });

  test("encrypts before creating and never starts when encryption fails", async () => {
    const { agentManagement, records, starts } = fixture({ encryptionFails: true });
    await expect(
      agentManagement.create(
        { userId: "user-1", workspaceId: "workspace-1" },
        {
          name: "secure",
          description: "",
          provider: RUNTIME_PROVIDER.COFORGE,
          computerId: "computer-1",
          modelProvider: "openai",
          apiKey: "secret-key-1234",
        },
      ),
    ).rejects.toThrow("encryption unavailable");
    expect(records).toEqual([]);
    expect(starts).toEqual([]);
  });

  test("stores an external Pi API key in managed provider config and strips it from results", async () => {
    const { agentManagement, starts } = fixture();

    const result = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "external-pi",
        description: "External Pi agent",
        provider: RUNTIME_PROVIDER.PI,
        computerId: "computer-1",
        modelProvider: "anthropic",
        apiKey: "secret-key-1234",
      },
    );

    expect(result.agent.runtimeConfig).toMatchObject({
      runtime: RUNTIME_PROVIDER.PI,
      provider: { kind: "coforge", providerId: "anthropic" },
      modelProvider: "anthropic",
    });
    expect(starts[0]).toMatchObject({ intent: { modelProvider: "anthropic" } });
  });

  test("creates an authorized manual CoForge model without a catalog match", async () => {
    const { agentManagement } = fixture();
    const result = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "manual-model",
        description: "Manual model",
        provider: RUNTIME_PROVIDER.COFORGE,
        computerId: "computer-1",
        modelProvider: "deepseek",
        model: "future-model",
        apiKey: "secret-key-1234",
      },
    );
    expect(result.agent.runtimeConfig).toMatchObject({
      runtime: RUNTIME_PROVIDER.COFORGE,
      provider: { kind: "coforge", providerId: "deepseek" },
      modelProvider: "deepseek",
      model: "future-model",
    });
  });

  test("requires a key for CoForge creation but permits Pi local auth", async () => {
    const { agentManagement } = fixture();
    await expect(
      agentManagement.create(
        { userId: "user-1", workspaceId: "workspace-1" },
        {
          name: "missing-key",
          description: "",
          provider: RUNTIME_PROVIDER.COFORGE,
          computerId: "computer-1",
          modelProvider: "openai",
        },
      ),
    ).rejects.toThrow("API key is required");
    const pi = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "local-pi",
        description: "",
        provider: RUNTIME_PROVIDER.PI,
        computerId: "computer-1",
        modelProvider: "openai",
      },
    );
    expect(pi.agent.runtimeConfig.provider).toEqual({ kind: "default" });
  });

  test("defaults modelProvider for persisted runtime configs created before the field", () => {
    expect(
      parseAgentRuntimeConfig({
        runtime: RUNTIME_PROVIDER.PI,
        provider: { kind: "default" },
        model: "",
        reasoning: "",
      }),
    ).toMatchObject({ modelProvider: "" });
  });

  test("keeps the canonical Agent when start publication fails", async () => {
    const { agentManagement, records } = fixture({ publishFails: true });
    const result = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "builder",
        description: "Build helper",
        provider: RUNTIME_PROVIDER.CODEX,
        computerId: "computer-1",
      },
    );

    expect(result.startPublished).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]?.runtimeConfig).toEqual({
      runtime: "codex",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    });
  });

  test("rejects a Provider unavailable on the selected Computer", async () => {
    const { agentManagement, records } = fixture({ unavailable: true });
    await expect(
      agentManagement.create(
        { userId: "user-1", workspaceId: "workspace-1" },
        {
          name: "builder",
          description: "Build helper",
          provider: RUNTIME_PROVIDER.CODEX,
          computerId: "computer-1",
        },
      ),
    ).rejects.toThrow("runtime selection is not available on the selected Computer");
    expect(records).toEqual([]);
  });

  test("updates metadata without control and keeps the Computer fixed", async () => {
    const { agentManagement, records, controls, updates } = fixture();
    const created = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "old",
        description: "Old",
        provider: RUNTIME_PROVIDER.PI,
        computerId: "computer-1",
      },
    );
    controls.length = 0;
    const result = await agentManagement.update(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        agentId: created.agent.id,
        name: " New ",
        description: " New description ",
        provider: RUNTIME_PROVIDER.PI,
      },
    );
    expect(result.restart).toBe("not-required");
    expect(records[0]).toMatchObject({
      name: "new",
      displayName: "new",
      computerId: "computer-1",
    });
    expect(controls).toEqual(["persist"]);
    expect(updates[0]).not.toHaveProperty("runtimeConfig");
  });

  test("updates metadata when the unchanged runtime is no longer selectable", async () => {
    const { agentManagement, records, controls } = fixture({
      unavailable: true,
    });
    records.push({
      id: "agent-1",
      workspaceId: "workspace-1",
      ownerId: "user-1",
      computerId: "computer-1",
      name: "old",
      displayName: "old",
      description: "Old description",
      createdAt: new Date(),
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.CODEX,
        provider: { kind: "default" },
        model: "gpt-5",
        modelProvider: "openai",
        reasoning: "high",
      },
    });

    const result = await agentManagement.update(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        agentId: "agent-1",
        name: "new",
        description: "New description",
        provider: RUNTIME_PROVIDER.CODEX,
        model: "gpt-5",
        modelProvider: "openai",
        reasoning: "high",
      },
    );

    expect(result.restart).toBe("not-required");
    expect(controls).toEqual(["persist"]);
  });

  test("stops, persists, then starts a runtime update and preserves only the same provider key", async () => {
    const { agentManagement, records, controls } = fixture();
    records.push({
      id: "agent-1",
      workspaceId: "workspace-1",
      ownerId: "user-1",
      computerId: "computer-1",
      name: "builder",
      displayName: "builder",
      createdAt: new Date(),
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.COFORGE,
        provider: {
          kind: "coforge",
          providerId: "openai",
          apiKey: { keyId: "k", ciphertext: "c", nonce: "n", hint: "***" },
        },
        model: "old",
        modelProvider: "openai",
        reasoning: "",
      },
    });
    await agentManagement.update(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        agentId: "agent-1",
        name: "builder",
        description: "",
        provider: RUNTIME_PROVIDER.COFORGE,
        model: "new",
        modelProvider: "openai",
      },
    );
    expect(controls).toEqual(["stop", "persist", "start"]);
    expect(records[0]!.runtimeConfig.provider).toMatchObject({
      apiKey: { ciphertext: "c" },
    });
    controls.length = 0;
    await expect(
      agentManagement.update(
        { userId: "user-1", workspaceId: "workspace-1" },
        {
          agentId: "agent-1",
          name: "builder",
          description: "",
          provider: RUNTIME_PROVIDER.COFORGE,
          modelProvider: "anthropic",
        },
      ),
    ).rejects.toThrow("API key is required");
    await agentManagement.update(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        agentId: "agent-1",
        name: "builder",
        description: "",
        provider: RUNTIME_PROVIDER.COFORGE,
        modelProvider: "anthropic",
        apiKey: "replacement-key-1234",
      },
    );
    expect(records[0]!.runtimeConfig.provider).toMatchObject({
      providerId: "anthropic",
      apiKey: { ciphertext: "encrypted:replacement-key-1234" },
    });
  });

  test("restarts for a key-only update and never returns ciphertext", async () => {
    const { agentManagement, records, controls } = fixture();
    records.push({
      id: "agent-1",
      workspaceId: "workspace-1",
      ownerId: "user-1",
      computerId: "computer-1",
      name: "pi",
      displayName: "pi",
      createdAt: new Date(),
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.PI,
        provider: {
          kind: "coforge",
          providerId: "openai",
          apiKey: { keyId: "v1", ciphertext: "old", nonce: "nonce", hint: "••••old1" },
        },
        model: "gpt",
        modelProvider: "openai",
        reasoning: "",
      },
    });
    const result = await agentManagement.update(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        agentId: "agent-1",
        name: "pi",
        description: "",
        provider: RUNTIME_PROVIDER.PI,
        model: "gpt",
        modelProvider: "openai",
        apiKey: "new-secret-1234",
      },
    );
    expect(controls).toEqual(["stop", "persist", "start"]);
    expect(result.agent.runtimeConfig.provider).not.toHaveProperty("apiKey");
    expect(JSON.stringify(result)).not.toContain("encrypted:new-secret-1234");
  });

  test("Pi model edits advertise the preserved key without disclosing it to catalog checks", async () => {
    const { agentManagement, selections } = fixture();
    const principal = { userId: "user-1", workspaceId: "workspace-1" };
    const input = {
      name: "pi",
      description: "",
      provider: RUNTIME_PROVIDER.PI,
      computerId: "computer-1",
      modelProvider: "openai",
      model: "gpt-5",
    };
    const created = await agentManagement.create(principal, {
      ...input,
      apiKey: "secret-key-1234",
    });
    await agentManagement.update(principal, {
      ...input,
      agentId: created.agent.id,
      model: "gpt-5-mini",
    });
    expect(selections).toHaveLength(2);
    for (const selection of selections) {
      expect(selection.hasApiKey).toBe(true);
      expect(selection).not.toHaveProperty("apiKey");
    }
  });

  test("does not persist after stop failure and reports a deferred start failure", async () => {
    const stopped = fixture({ stopFails: true });
    const created = await stopped.agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "a",
        description: "",
        provider: RUNTIME_PROVIDER.PI,
        computerId: "computer-1",
      },
    );
    stopped.controls.length = 0;
    await expect(
      stopped.agentManagement.update(
        { userId: "user-1", workspaceId: "workspace-1" },
        {
          agentId: created.agent.id,
          name: "a",
          description: "",
          provider: RUNTIME_PROVIDER.CODEX,
        },
      ),
    ).rejects.toThrow("stop unavailable");
    expect(stopped.controls).toEqual(["stop"]);

    const deferred = fixture({ publishFails: true });
    const other = await deferred.agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "a",
        description: "",
        provider: RUNTIME_PROVIDER.PI,
        computerId: "computer-1",
      },
    );
    deferred.controls.length = 0;
    expect(
      (
        await deferred.agentManagement.update(
          { userId: "user-1", workspaceId: "workspace-1" },
          {
            agentId: other.agent.id,
            name: "a",
            description: "",
            provider: RUNTIME_PROVIDER.CODEX,
          },
        )
      ).restart,
    ).toBe("deferred");
    expect(deferred.controls).toEqual(["stop", "persist", "start"]);
  });
});
