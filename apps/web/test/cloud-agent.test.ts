import { describe, expect, test } from "bun:test";
import { decodeAgentStartIntent, encodeAgentActivity, RUNTIME_PROVIDER } from "@coforge/protocol";
import { CloudAgentUseCase, WorkspaceAgentRecovery } from "../src/server/agents/cloud-agent.server";

describe("CloudAgentUseCase", () => {
  test("ready recovery publishes stored runtime config for every Workspace Agent", async () => {
    const payloads: Uint8Array[] = [];
    const channels: string[] = [];
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
              runtime: RUNTIME_PROVIDER.CLAUDE_CODE,
              provider: { kind: "default" },
              model: "sonnet",
              modelProvider: "",
              reasoning: "high",
            },
          },
        ],
      },
      {
        publish: async (channel, payload) => {
          channels.push(channel);
          payloads.push(payload);
        },
      },
    );

    await recovery.recoverWorkspace("workspace-1", "computer-1");

    expect(payloads).toHaveLength(1);
    expect(channels).toEqual(["daemon:computer-1"]);
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
    const channels: string[] = [];
    const useCase = new CloudAgentUseCase(
      {
        computerIdForAuthorizedAgent: async () => "computer-1",
      },
      {
        publish: async (channel, payload) => {
          channels.push(channel);
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
        computerId: "computer-1",
        agentId: "agent-1",
        provider: RUNTIME_PROVIDER.PI,
        model: "",
        reasoning: "",
      },
      "user-1",
    );

    expect(channels).toEqual(["daemon:computer-1"]);
    expect(decodeAgentStartIntent(payloads[0]!)).toMatchObject({ model: "", reasoning: "" });
  });

  test("derives the start target from the authorized Agent and routes scoped activity", async () => {
    const published: Uint8Array[] = [];
    const activities: unknown[] = [];
    const useCase = new CloudAgentUseCase(
      {
        computerIdForAuthorizedAgent: async () => "computer-1",
      },
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
        computerId: "forged-computer",
        agentId: "a",
        provider: "pi",
        model: "m",
        reasoning: "r",
      },
      "u",
    );
    expect(decodeAgentStartIntent(published[0]!)).toMatchObject({ computerId: "computer-1" });
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
      { computerIdForAuthorizedAgent: async () => "computer-1" },
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
