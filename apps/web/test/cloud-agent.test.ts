import { describe, expect, test } from "bun:test";
import { decodeAgentStartIntent, encodeAgentActivity, RUNTIME_PROVIDER } from "@coforge/protocol";
import { CloudAgentUseCase, WorkspaceAgentRecovery } from "../src/server/agents/cloud-agent.server";

describe("CloudAgentUseCase", () => {
  test("ready recovery publishes stored runtime config for every Workspace Agent", async () => {
    const payloads: Uint8Array[] = [];
    const recovery = new WorkspaceAgentRecovery(
      {
        getById: async () => undefined,
        listOwnedInWorkspace: async () => [],
        listInWorkspace: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        listForComputer: async () => [
          {
            id: "agent-1",
            workspaceId: "workspace-1",
            ownerId: "user-1",
            name: "builder",
            displayName: "Builder",
            createdAt: new Date(),
            runtimeConfig: {
              provider: RUNTIME_PROVIDER.CLAUDE_CODE,
              model: "sonnet",
              modelProvider: "",
              reasoning: "high",
            },
          },
        ],
      },
      {
        publish: async (_channel, payload) => {
          payloads.push(payload);
        },
      },
    );

    await recovery.recoverWorkspace("workspace-1", "computer-1");

    expect(payloads).toHaveLength(1);
    expect(decodeAgentStartIntent(payloads[0]!)).toMatchObject({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      provider: "claude-code",
      model: "sonnet",
      reasoning: "high",
    });
  });

  test("publishes an Agent start when optional model and reasoning are empty", async () => {
    const payloads: Uint8Array[] = [];
    const useCase = new CloudAgentUseCase(
      { canUseAgent: async () => true },
      {
        publish: async (_channel, payload) => {
          payloads.push(payload);
        },
      },
      async () => {},
    );

    await useCase.start(
      {
        protocolMajor: 1,
        requestId: "start-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        provider: RUNTIME_PROVIDER.PI,
        model: "",
        reasoning: "",
      },
      "user-1",
    );

    expect(decodeAgentStartIntent(payloads[0]!)).toMatchObject({ model: "", reasoning: "" });
  });

  test("publishes an authorized start and routes a scoped activity", async () => {
    const published: Uint8Array[] = [];
    const activities: unknown[] = [];
    const useCase = new CloudAgentUseCase(
      { canUseAgent: async () => true },
      {
        publish: async (_channel, data) => {
          published.push(data);
        },
      },
      async (activity) => {
        activities.push(activity);
      },
    );
    await useCase.start(
      {
        protocolMajor: 1,
        requestId: "r",
        workspaceId: "w",
        agentId: "a",
        provider: "pi",
        model: "m",
        reasoning: "r",
      },
      "u",
    );
    await useCase.receiveActivity(
      encodeAgentActivity({
        protocolMajor: 1,
        requestId: "e",
        workspaceId: "w",
        agentId: "a",
        activity: "starting",
        level: "info",
        message: "started",
        occurredAt: "2026-08-27T00:00:00.000Z",
        launchId: "launch-1",
        clientSeq: 1,
      }),
      { workspaceId: "w", agentId: "a" },
    );
    expect(published).toHaveLength(1);
    expect(activities).toHaveLength(1);
  });

  test("rejects an activity for another agent", async () => {
    const useCase = new CloudAgentUseCase(
      { canUseAgent: async () => true },
      { publish: async () => {} },
      async () => {},
    );
    expect(
      useCase.receiveActivity(
        encodeAgentActivity({
          protocolMajor: 1,
          requestId: "e",
          workspaceId: "w",
          agentId: "a",
          activity: "error",
          level: "error",
          message: "failed",
          occurredAt: "2026-08-27T00:00:00.000Z",
          launchId: "launch-1",
          clientSeq: 1,
        }),
        { workspaceId: "w", agentId: "other" },
      ),
    ).rejects.toThrow("scope");
  });
});
