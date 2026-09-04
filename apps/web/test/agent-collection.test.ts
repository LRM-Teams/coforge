import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { AgentCollection } from "../src/server/agents/agent-collection.server";
import { parseAgentRuntimeConfig } from "../src/server/agents/agent-runtime-config.server";
import type {
  AgentRecord,
  AgentRepository,
} from "../src/server/db/repositories/agent.repositories.server";

function fixture(options?: { publishFails?: boolean; unavailable?: boolean }) {
  const records: AgentRecord[] = [];
  const starts: unknown[] = [];
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
  };
  const collection = new AgentCollection(
    repository,
    {
      start: async (intent, userId) => {
        starts.push({ intent, userId });
        if (options?.publishFails) throw new Error("daemon unavailable");
      },
    },
    { canRun: async () => !options?.unavailable },
  );
  return { collection, records, starts };
}

describe("AgentCollection", () => {
  test("lists and creates only for the authenticated user's current Workspace", async () => {
    const { collection, records, starts } = fixture();
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

    const result = await collection.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "  MY-Agent  ",
        displayName: " My Agent ",
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
      displayName: "My Agent",
      runtimeConfig: {
        runtime: "coforge",
        provider: { kind: "coforge", providerId: "anthropic" },
        model: "model-a",
        modelProvider: "anthropic",
        reasoning: "high",
      },
    });
    expect(await collection.list({ userId: "user-1", workspaceId: "workspace-1" })).toEqual([
      result.agent,
    ]);
    expect(starts).toHaveLength(1);
  });

  test("keeps an external Pi model provider as the default provider config", async () => {
    const { collection, starts } = fixture();

    const result = await collection.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "external-pi",
        displayName: "External Pi",
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
    const { collection, records } = fixture({ publishFails: true });
    const result = await collection.create(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        name: "builder",
        displayName: "Builder",
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
    const { collection, records } = fixture({ unavailable: true });
    await expect(
      collection.create(
        { userId: "user-1", workspaceId: "workspace-1" },
        {
          name: "builder",
          displayName: "Builder",
          provider: RUNTIME_PROVIDER.CODEX,
          computerId: "computer-1",
        },
      ),
    ).rejects.toThrow("runtime selection is not available on the selected Computer");
    expect(records).toEqual([]);
  });

  test("retries a persisted Agent start with its selected runtime", async () => {
    const { collection, records, starts } = fixture();
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

    await collection.retryStart({ userId: "user-1", workspaceId: "workspace-1" }, "agent-1");

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
});
