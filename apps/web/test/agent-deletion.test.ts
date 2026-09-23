import { describe, expect, test } from "bun:test";

import { AgentDeletion, type AgentDeletionStore } from "@/server/agents/agent-deletion.server";
import type {
  AgentRecord,
  AgentRepository,
} from "@/server/db/repositories/agent.repositories.server";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: "builder",
    displayName: "Builder",
    description: "",
    computerId: "computer-1",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    runtimeConfig: {
      runtime: "codex",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    ...overrides,
  };
}

function repositoryFor(record: AgentRecord | undefined): AgentRepository {
  return {
    getById: async (id) => (id === record?.id ? record : undefined),
    listInWorkspace: async () => (record ? [record] : []),
    listForComputer: async () => (record ? [record] : []),
    listDeletedForComputer: async () => [],
    listOwnedInWorkspace: async () => (record ? [record] : []),
    create: async () => record!,
    update: async () => record!,
  };
}

function fixture(options?: { stopFails?: boolean; record?: AgentRecord }) {
  const record = options?.record ?? agent();
  const stops: Array<{ agentId: string; userId: string }> = [];
  const effects: Parameters<AgentDeletionStore["delete"]>[0][] = [];
  const store: AgentDeletionStore = {
    delete: async (input) => {
      effects.push(input);
      return {
        outcome: "deleted",
        membershipsLeft: 2,
        remindersCanceled: 1,
        apiKeysRevoked: 1,
      };
    },
  };
  const deletion = new AgentDeletion(
    repositoryFor(record),
    store,
    {
      stop: async (intent, userId) => {
        stops.push({ agentId: intent.agentId, userId });
        if (options?.stopFails) throw new Error("daemon unavailable");
      },
    },
    { run: async (_agentId, callback) => callback() },
    () => new Date("2026-09-18T04:00:00Z"),
  );
  return { deletion, stops, effects, record };
}

const owner = { userId: "user-1", workspaceId: "workspace-1", role: "owner" as const };

describe("AgentDeletion", () => {
  test("a plain member cannot delete an Agent, even their own", async () => {
    const { deletion, effects } = fixture();
    await expect(
      deletion.delete({ userId: "user-1", workspaceId: "workspace-1", role: "member" }, "agent-1"),
    ).rejects.toMatchObject({ name: "AppError", code: "ACCESS_DENIED" });
    expect(effects).toEqual([]);
  });

  test("an owner or admin deletes the Agent and stops its runtime", async () => {
    const { deletion, effects, stops } = fixture();
    const result = await deletion.delete(owner, "agent-1");
    expect(result).toMatchObject({
      outcome: "deleted",
      membershipsLeft: 2,
      remindersCanceled: 1,
    });
    expect(effects).toEqual([
      {
        agentId: "agent-1",
        workspaceId: "workspace-1",
        deletedAt: new Date("2026-09-18T04:00:00Z"),
      },
    ]);
    expect(stops).toEqual([{ agentId: "agent-1", userId: "user-1" }]);
  });

  test("an admin may delete an Agent owned by someone else", async () => {
    const { deletion } = fixture({ record: agent({ ownerId: "user-2" }) });
    const result = await deletion.delete(
      { userId: "user-1", workspaceId: "workspace-1", role: "admin" },
      "agent-1",
    );
    expect(result.outcome).toBe("deleted");
  });

  test("an Agent outside the actor's Workspace is NOT_FOUND and never touched", async () => {
    const { deletion, effects } = fixture({ record: agent({ workspaceId: "other-workspace" }) });
    await expect(deletion.delete(owner, "agent-1")).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
    expect(effects).toEqual([]);
  });

  test("an unknown Agent is NOT_FOUND", async () => {
    const { deletion } = fixture();
    await expect(deletion.delete(owner, "missing")).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
  });

  test("an Agent with no Computer is deleted without a runtime stop", async () => {
    const { deletion, stops } = fixture({ record: agent({ computerId: undefined }) });
    expect((await deletion.delete(owner, "agent-1")).outcome).toBe("deleted");
    expect(stops).toEqual([]);
  });

  test("a failed runtime stop never fails the delete the user asked for", async () => {
    const { deletion, effects } = fixture({ stopFails: true });
    expect((await deletion.delete(owner, "agent-1")).outcome).toBe("deleted");
    expect(effects).toHaveLength(1);
  });

  test("deleting an already-deleted Agent is an idempotent no-op with no second stop", async () => {
    const stops: string[] = [];
    const deletion = new AgentDeletion(
      repositoryFor(agent({ deletedAt: new Date("2026-09-18T03:00:00Z") })),
      { delete: async () => ({ outcome: "already-deleted" }) },
      {
        stop: async (intent) => {
          stops.push(intent.agentId);
        },
      },
      { run: async (_agentId, callback) => callback() },
    );
    expect((await deletion.delete(owner, "agent-1")).outcome).toBe("already-deleted");
    expect(stops).toEqual([]);
  });

  test("the weekly-report assistant is refused and never stopped", async () => {
    const stops: string[] = [];
    const deletion = new AgentDeletion(
      repositoryFor(agent()),
      { delete: async () => ({ outcome: "protected" }) },
      {
        stop: async (intent) => {
          stops.push(intent.agentId);
        },
      },
      { run: async (_agentId, callback) => callback() },
    );
    expect((await deletion.delete(owner, "agent-1")).outcome).toBe("protected");
    expect(stops).toEqual([]);
  });
});
