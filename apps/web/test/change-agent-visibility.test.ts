import { describe, expect, test } from "bun:test";

import {
  ChangeAgentVisibility,
  type ChangeAgentVisibilityStore,
} from "#src/server/agents/change-agent-visibility.server";
import type {
  AgentRecord,
  AgentRepository,
} from "#src/server/db/repositories/agent.repositories.server";
import type { AgentInboxPurgeRequest } from "#src/server/agents/agent-inbox-purge.server";

/** Records inbox purges; the real publisher never rejects, so neither does this one. */
function recordingInboxPurge() {
  const purged: AgentInboxPurgeRequest[] = [];
  return {
    purged,
    inboxPurge: {
      purge: async (request: AgentInboxPurgeRequest) => {
        purged.push(request);
      },
    },
  };
}

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
    visibility: "public",
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

function fixture(options?: {
  record?: AgentRecord;
  changed?: boolean;
  leftChannelIds?: string[];
  joinedChannelIds?: string[];
  announceFails?: boolean;
}) {
  const record = options?.record ?? agent();
  const applied: Parameters<ChangeAgentVisibilityStore["apply"]>[0][] = [];
  const notified: Array<{ workspaceId: string; agentId: string }> = [];
  const announced: Array<{ workspaceId: string; conversationIds: readonly string[] }> = [];
  const store: ChangeAgentVisibilityStore = {
    apply: async (input) => {
      applied.push(input);
      const changed = options?.changed ?? true;
      return {
        changed,
        leftChannelIds: changed ? (options?.leftChannelIds ?? []) : [],
        joinedChannelIds: changed ? (options?.joinedChannelIds ?? []) : [],
      };
    },
    preview: async () => ({ channelNames: ["general"], readOnlyDirectMessageCount: 1 }),
  };
  const { purged, inboxPurge } = recordingInboxPurge();
  const useCase = new ChangeAgentVisibility(
    repositoryFor(record),
    store,
    async (workspaceId, agentId) => {
      notified.push({ workspaceId, agentId });
    },
    inboxPurge,
    {
      memberChanged: async (input) => {
        if (options?.announceFails) throw new Error("realtime unavailable");
        announced.push(input);
      },
    },
  );
  return { useCase, applied, notified, announced, purged, record };
}

describe("ChangeAgentVisibility", () => {
  test("the creator may make their own Agent private", async () => {
    const { useCase, applied, notified } = fixture();
    const result = await useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "member" },
      { agentId: "agent-1", visibility: "private" },
    );
    expect(result).toEqual({ visibility: "private", changed: true });
    expect(applied).toEqual([
      { agentId: "agent-1", workspaceId: "workspace-1", visibility: "private" },
    ]);
    expect(notified).toEqual([{ workspaceId: "workspace-1", agentId: "agent-1" }]);
  });

  test("going private tells each channel the Agent left that its member list changed", async () => {
    const { useCase, announced } = fixture({ leftChannelIds: ["channel-1", "channel-2"] });
    await useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "member" },
      { agentId: "agent-1", visibility: "private" },
    );
    expect(announced).toEqual([
      { workspaceId: "workspace-1", conversationIds: ["channel-1", "channel-2"] },
    ]);
  });

  test("going private tells the Agent's daemon to drop every channel it left, in one purge", async () => {
    const { useCase, purged } = fixture({ leftChannelIds: ["channel-1", "channel-2"] });
    await useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "member" },
      { agentId: "agent-1", visibility: "private" },
    );
    expect(purged).toEqual([
      {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        conversationIds: ["channel-1", "channel-2"],
        reason: "visibility_private",
      },
    ]);
  });

  test("going public or setting the same visibility again purges nothing", async () => {
    const madePublic = fixture({
      record: agent({ visibility: "private" }),
      joinedChannelIds: ["general"],
    });
    await madePublic.useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "member" },
      { agentId: "agent-1", visibility: "public" },
    );
    const unchanged = fixture({ changed: false });
    await unchanged.useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "member" },
      { agentId: "agent-1", visibility: "private" },
    );
    expect([...madePublic.purged, ...unchanged.purged]).toEqual([]);
  });

  test("a member-list signal that cannot be sent never fails the visibility change", async () => {
    const { useCase } = fixture({ leftChannelIds: ["channel-1"], announceFails: true });
    expect(
      await useCase.execute(
        { userId: "user-1", workspaceId: "workspace-1", role: "member" },
        { agentId: "agent-1", visibility: "private" },
      ),
    ).toEqual({ visibility: "private", changed: true });
  });

  test("a Workspace admin may change visibility for an Agent owned by someone else", async () => {
    const { useCase, applied } = fixture({ record: agent({ ownerId: "user-2" }) });
    await useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "admin" },
      { agentId: "agent-1", visibility: "private" },
    );
    expect(applied).toHaveLength(1);
  });

  test("a plain member who is not the creator cannot change visibility", async () => {
    const { useCase, applied, notified } = fixture({ record: agent({ ownerId: "user-2" }) });
    await expect(
      useCase.execute(
        { userId: "user-1", workspaceId: "workspace-1", role: "member" },
        { agentId: "agent-1", visibility: "private" },
      ),
    ).rejects.toMatchObject({ name: "AppError", code: "ACCESS_DENIED" });
    expect(applied).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("an Agent outside the actor's Workspace is NOT_FOUND", async () => {
    const { useCase, applied } = fixture({ record: agent({ workspaceId: "other-workspace" }) });
    await expect(
      useCase.execute(
        { userId: "user-1", workspaceId: "workspace-1", role: "owner" },
        { agentId: "agent-1", visibility: "private" },
      ),
    ).rejects.toMatchObject({ name: "AppError", code: "NOT_FOUND" });
    expect(applied).toEqual([]);
  });

  test("an unknown Agent is NOT_FOUND", async () => {
    const { useCase } = fixture();
    await expect(
      useCase.execute(
        { userId: "user-1", workspaceId: "workspace-1", role: "owner" },
        { agentId: "missing", visibility: "private" },
      ),
    ).rejects.toMatchObject({ name: "AppError", code: "NOT_FOUND" });
  });

  test("a deleted Agent's visibility cannot be changed", async () => {
    const { useCase, applied } = fixture({
      record: agent({ deletedAt: new Date("2026-09-18T04:00:00Z") }),
    });
    await expect(
      useCase.execute(
        { userId: "user-1", workspaceId: "workspace-1", role: "owner" },
        { agentId: "agent-1", visibility: "private" },
      ),
    ).rejects.toMatchObject({ name: "AppError", code: "NOT_FOUND" });
    expect(applied).toEqual([]);
  });

  test("setting the same visibility again is a no-op that never notifies", async () => {
    const { useCase, notified } = fixture({ changed: false });
    const result = await useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "member" },
      { agentId: "agent-1", visibility: "public" },
    );
    expect(result).toEqual({ visibility: "public", changed: false });
    expect(notified).toEqual([]);
  });

  test("a failed browser notification does not fail the committed change", async () => {
    const record = agent();
    const useCase = new ChangeAgentVisibility(
      repositoryFor(record),
      {
        apply: async () => ({ changed: true, leftChannelIds: [], joinedChannelIds: [] }),
        preview: async () => ({ channelNames: [], readOnlyDirectMessageCount: 0 }),
      },
      async () => {
        throw new Error("realtime unavailable");
      },
      recordingInboxPurge().inboxPurge,
    );
    const result = await useCase.execute(
      { userId: "user-1", workspaceId: "workspace-1", role: "member" },
      { agentId: "agent-1", visibility: "private" },
    );
    expect(result).toEqual({ visibility: "private", changed: true });
  });

  test("the preview is shown to the creator", async () => {
    const { useCase } = fixture();
    expect(
      await useCase.preview(
        { userId: "user-1", workspaceId: "workspace-1", role: "member" },
        "agent-1",
      ),
    ).toEqual({ channelNames: ["general"], readOnlyDirectMessageCount: 1 });
  });

  test("the preview is shown to a Workspace admin for someone else's Agent", async () => {
    const { useCase } = fixture({ record: agent({ ownerId: "user-2" }) });
    expect(
      await useCase.preview(
        { userId: "user-1", workspaceId: "workspace-1", role: "admin" },
        "agent-1",
      ),
    ).toEqual({ channelNames: ["general"], readOnlyDirectMessageCount: 1 });
  });

  test("the preview is refused to a member who cannot change visibility", async () => {
    const { useCase } = fixture({ record: agent({ ownerId: "user-2", visibility: "private" }) });
    await expect(
      useCase.preview({ userId: "user-1", workspaceId: "workspace-1", role: "member" }, "agent-1"),
    ).rejects.toMatchObject({ name: "AppError", code: "ACCESS_DENIED" });
  });
});
