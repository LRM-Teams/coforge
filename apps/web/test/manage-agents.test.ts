import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { ManageAgents } from "../src/server/agents/manage-agents.server";
import { parseAgentRuntimeConfig } from "../src/server/agents/agent-runtime-config.server";
import type {
  AgentRecord,
  AgentRepository,
} from "../src/server/db/repositories/agent.repositories.server";

function fixture(options?: { publishFails?: boolean; stopFails?: boolean; unavailable?: boolean }) {
  const records: AgentRecord[] = [];
  const starts: unknown[] = [];
  const controls: string[] = [];
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
        id: `agent-${records.length + 1}`,
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
    { canRun: async () => !options?.unavailable },
    { run: async (_agentId, callback) => callback() },
  );
  return { agentManagement, records, starts, controls, updates };
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
    expect(await agentManagement.list({ userId: "user-1", workspaceId: "workspace-1" })).toEqual([
      result.agent,
    ]);
    expect(starts).toHaveLength(1);
  });

  test("keeps an external Pi model provider as the default provider config", async () => {
    const { agentManagement, starts } = fixture();

    const result = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "external-pi",
        description: "External Pi agent",
        provider: RUNTIME_PROVIDER.PI,
        computerId: "computer-1",
        modelProvider: "anthropic",
      },
    );

    expect(result.agent.runtimeConfig).toMatchObject({
      runtime: RUNTIME_PROVIDER.PI,
      provider: { kind: "default" },
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
      },
    );
    expect(result.agent.runtimeConfig).toMatchObject({
      runtime: RUNTIME_PROVIDER.COFORGE,
      provider: { kind: "coforge", providerId: "deepseek" },
      modelProvider: "deepseek",
      model: "future-model",
    });
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

  test("retries a persisted Agent start with its selected runtime", async () => {
    const { agentManagement, records, starts } = fixture();
    records.push({
      id: "agent-1",
      workspaceId: "workspace-1",
      ownerId: "user-1",
      computerId: "computer-1",
      name: "builder",
      displayName: "Builder",
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.CODEX,
        provider: { kind: "default" },
        model: "gpt-5",
        modelProvider: "",
        reasoning: "high",
      },
      createdAt: new Date(),
    });

    await agentManagement.retryStart({ userId: "user-1", workspaceId: "workspace-1" }, "agent-1");

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      userId: "user-1",
      intent: {
        workspaceId: "workspace-1",
        computerId: "computer-1",
        agentId: "agent-1",
        provider: "codex",
        model: "gpt-5",
        modelProvider: "",
        reasoning: "high",
      },
    });
  });

  test("updates metadata without control and keeps the Computer fixed", async () => {
    const { agentManagement, records, controls, updates } = fixture();
    const created = await agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      { name: "old", description: "Old", provider: RUNTIME_PROVIDER.PI, computerId: "computer-1" },
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
    expect(records[0]).toMatchObject({ name: "new", displayName: "new", computerId: "computer-1" });
    expect(controls).toEqual(["persist"]);
    expect(updates[0]).not.toHaveProperty("runtimeConfig");
  });

  test("updates metadata when the unchanged runtime is no longer selectable", async () => {
    const { agentManagement, records, controls } = fixture({ unavailable: true });
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
    expect(records[0]!.runtimeConfig.provider).toMatchObject({ apiKey: { ciphertext: "c" } });
    controls.length = 0;
    await agentManagement.update(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        agentId: "agent-1",
        name: "builder",
        description: "",
        provider: RUNTIME_PROVIDER.COFORGE,
        modelProvider: "anthropic",
      },
    );
    expect(records[0]!.runtimeConfig.provider).not.toHaveProperty("apiKey");
  });

  test("does not persist after stop failure and reports a deferred start failure", async () => {
    const stopped = fixture({ stopFails: true });
    const created = await stopped.agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      { name: "a", description: "", provider: RUNTIME_PROVIDER.PI, computerId: "computer-1" },
    );
    stopped.controls.length = 0;
    await expect(
      stopped.agentManagement.update(
        { userId: "user-1", workspaceId: "workspace-1" },
        { agentId: created.agent.id, name: "a", description: "", provider: RUNTIME_PROVIDER.CODEX },
      ),
    ).rejects.toThrow("stop unavailable");
    expect(stopped.controls).toEqual(["stop"]);

    const deferred = fixture({ publishFails: true });
    const other = await deferred.agentManagement.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      { name: "a", description: "", provider: RUNTIME_PROVIDER.PI, computerId: "computer-1" },
    );
    deferred.controls.length = 0;
    expect(
      (
        await deferred.agentManagement.update(
          { userId: "user-1", workspaceId: "workspace-1" },
          { agentId: other.agent.id, name: "a", description: "", provider: RUNTIME_PROVIDER.CODEX },
        )
      ).restart,
    ).toBe("deferred");
    expect(deferred.controls).toEqual(["stop", "persist", "start"]);
  });
});
