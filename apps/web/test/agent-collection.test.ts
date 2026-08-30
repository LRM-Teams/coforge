import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { AgentCollection } from "../src/server/agents/agent-collection.server";
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
        provider: RUNTIME_PROVIDER.CODEX,
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
        provider: RUNTIME_PROVIDER.PI,
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
        provider: "pi",
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
      provider: "codex",
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
});
