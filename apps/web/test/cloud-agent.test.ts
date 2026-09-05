import { describe, expect, test } from "bun:test";
import {
  decodeAgentMessageDelivery,
  decodeAgentStartIntent,
  encodeAgentActivity,
  RUNTIME_PROVIDER,
} from "@coforge/protocol";
import { CloudAgentUseCase, WorkspaceAgentRecovery } from "../src/server/agents/cloud-agent.server";

describe("CloudAgentUseCase", () => {
  test("ready recovery publishes stored runtime config for every Workspace Agent", async () => {
    const payloads: Uint8Array[] = [];
    const channels: string[] = [];
    const recoveryReads: string[] = [];
    const pendingReads: string[] = [];
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
            id: "agent-running",
            workspaceId: "workspace-1",
            ownerId: "user-1",
            name: "running",
            displayName: "Running",
            createdAt: new Date(),
            runtimeConfig: {
              runtime: RUNTIME_PROVIDER.PI,
              provider: { kind: "default" },
              model: "default",
              modelProvider: "",
              reasoning: "balanced",
            },
          },
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
        readAgentRecoveryContext: async (_workspaceId, agentId) => {
          recoveryReads.push(agentId);
          return {
            resumeMessages: [
              {
                messageId: "message-1",
                deliveryId: "delivery-1",
                conversationId: "conversation-1",
                sequence: 7,
                target: "@alice",
                latestSender: "@alice",
                body: "recover this message",
              },
            ],
            unreadSummary: { "@alice": 4 },
          };
        },
        readPendingAgentDeliveries: async (_workspaceId, agentId) => {
          pendingReads.push(agentId);
          return [
            {
              messageId: "running-message-1",
              deliveryId: "running-delivery-1",
              conversationId: "running-conversation-1",
              sequence: 3,
              target: "@bob",
              latestSender: "@bob",
              body: "redeliver this body",
            },
          ];
        },
      },
      {
        publish: async (channel, payload) => {
          channels.push(channel);
          payloads.push(payload);
        },
      },
    );

    await recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-running"]);

    expect(payloads).toHaveLength(2);
    expect(channels).toEqual(["daemon:computer-1", "daemon:computer-1"]);
    expect(pendingReads).toEqual(["agent-running"]);
    expect(recoveryReads).toEqual(["agent-1"]);
    expect(decodeAgentMessageDelivery(payloads[0]!)).toMatchObject({
      messageId: "running-message-1",
      deliveryId: "running-delivery-1",
      conversationId: "running-conversation-1",
      sequence: 3,
      workspaceId: "workspace-1",
      agentId: "agent-running",
      target: "@bob",
      latestSender: "@bob",
      body: "redeliver this body",
    });
    expect(decodeAgentStartIntent(payloads[1]!)).toMatchObject({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      provider: "claude-code",
      model: "sonnet",
      reasoning: "high",
      resumeMessages: [
        {
          messageId: "message-1",
          deliveryId: "delivery-1",
          conversationId: "conversation-1",
          sequence: 7,
          target: "@alice",
          latestSender: "@alice",
          body: "recover this message",
        },
      ],
      unreadSummary: { "@alice": 4 },
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
