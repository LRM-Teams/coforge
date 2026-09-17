import { describe, expect, test } from "bun:test";
import {
  decodeAgentMessageDelivery,
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  encodeAgentActivity,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";
import {
  PublishAgentRuntimeControl,
  WorkspaceAgentRecovery,
} from "../src/server/agents/agent-runtime-control.server";
import {
  AgentControl,
  type AgentControlAgent,
  type AgentControlStore,
} from "../src/server/agents/agent-control.server";

describe("PublishAgentRuntimeControl", () => {
  test("ready recovery publishes stored runtime config for every Workspace Agent", async () => {
    const payloads: Uint8Array[] = [];
    const channels: string[] = [];
    const recoveryReads: string[] = [];
    const pendingReads: string[] = [];
    const agents = [
      {
        id: "agent-running",
        workspaceId: "workspace-1",
        ownerId: "user-1",
        computerId: "computer-1",
        name: "running",
        displayName: "Running",
        createdAt: new Date(),
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.PI,
          provider: { kind: "default" as const },
          model: "default",
          modelProvider: "",
          reasoning: "balanced",
        },
      },
      {
        id: "agent-1",
        workspaceId: "workspace-1",
        ownerId: "user-1",
        computerId: "computer-1",
        name: "builder",
        displayName: "Builder",
        createdAt: new Date(),
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.CLAUDE_CODE,
          provider: { kind: "default" as const },
          model: "sonnet",
          modelProvider: "",
          reasoning: "high",
        },
      },
    ];
    const recovery = new WorkspaceAgentRecovery(
      {
        getById: async (id) => agents.find((agent) => agent.id === id),
        listOwnedInWorkspace: async () => [],
        listInWorkspace: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        update: async () => {
          throw new Error("not used");
        },
        listForComputer: async () => agents.map((agent) => structuredClone(agent)),
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
      { run: async (_agentId, callback) => callback() },
    );

    await recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-running"]);

    expect(payloads).toHaveLength(2);
    expect(channels).toEqual(["daemon:workspace-1:computer-1", "daemon:workspace-1:computer-1"]);
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

  test("orders recovery after a runtime mutation and starts from the fresh locked config", async () => {
    let releaseMutation = () => {};
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let tail = Promise.resolve();
    const lock = {
      run: async <T>(_agentId: string, callback: () => Promise<T>) => {
        const previous = tail;
        let release = () => {};
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    };
    const current = {
      id: "agent-1",
      workspaceId: "workspace-1",
      ownerId: "user-1",
      computerId: "computer-1",
      name: "builder",
      displayName: "Builder",
      createdAt: new Date(),
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.PI,
        provider: { kind: "default" as const },
        model: "stale-model",
        modelProvider: "",
        reasoning: "",
      },
    };
    const payloads: Uint8Array[] = [];
    const mutation = lock.run(current.id, async () => {
      await mutationGate;
      current.runtimeConfig.model = "fresh-model";
    });
    const recovery = new WorkspaceAgentRecovery(
      {
        getById: async () => current,
        listOwnedInWorkspace: async () => [],
        listInWorkspace: async () => [],
        listForComputer: async () => [structuredClone(current)],
        create: async () => current,
        update: async () => current,
      },
      {
        readAgentRecoveryContext: async () => ({
          resumeMessages: [],
          unreadSummary: {},
        }),
        readPendingAgentDeliveries: async () => [],
      },
      { publish: async (_channel, payload) => void payloads.push(payload) },
      lock,
    );

    const recovering = recovery.recoverWorkspace("workspace-1", "computer-1", []);
    await Promise.resolve();
    expect(payloads).toEqual([]);
    releaseMutation();
    await Promise.all([mutation, recovering]);

    expect(decodeAgentStartIntent(payloads[0]!)).toMatchObject({
      model: "fresh-model",
    });
  });

  // --- ADR 0038: stopped Agents are excluded from ready recovery -------------------------------

  test("recoverWorkspace skips a stopped Agent the Daemon also reports not running", async () => {
    const payloads: Uint8Array[] = [];
    const recoveryReads: string[] = [];
    const pendingReads: string[] = [];
    const agents = [
      {
        id: "agent-stopped",
        workspaceId: "workspace-1",
        ownerId: "user-1",
        computerId: "computer-1",
        name: "stopped",
        displayName: "Stopped",
        createdAt: new Date(),
        stoppedAt: new Date("2026-09-17T00:00:00Z"),
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.PI,
          provider: { kind: "default" as const },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    ];
    const recovery = new WorkspaceAgentRecovery(
      {
        getById: async (id) => agents.find((agent) => agent.id === id),
        listOwnedInWorkspace: async () => [],
        listInWorkspace: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        update: async () => {
          throw new Error("not used");
        },
        listForComputer: async () => agents.map((agent) => structuredClone(agent)),
      },
      {
        readAgentRecoveryContext: async (_workspaceId, agentId) => {
          recoveryReads.push(agentId);
          return { resumeMessages: [], unreadSummary: {} };
        },
        readPendingAgentDeliveries: async (_workspaceId, agentId) => {
          pendingReads.push(agentId);
          return [];
        },
      },
      { publish: async (_channel, payload) => void payloads.push(payload) },
      { run: async (_agentId, callback) => callback() },
    );

    await recovery.recoverWorkspace("workspace-1", "computer-1", []);

    expect(payloads).toHaveLength(0);
    expect(recoveryReads).toEqual([]);
    expect(pendingReads).toEqual([]);
  });

  test("recoverWorkspace reconciles a stopped Agent the Daemon reports running with a Stop, without blocking on its result", async () => {
    const agents = [
      {
        id: "agent-stopped-running",
        workspaceId: "workspace-1",
        ownerId: "owner-1",
        computerId: "computer-1",
        name: "stopped",
        displayName: "Stopped",
        createdAt: new Date(),
        stoppedAt: new Date("2026-09-17T00:00:00Z"),
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.PI,
          provider: { kind: "default" as const },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    ];
    let controlAgent: AgentControlAgent = {
      id: "agent-stopped-running",
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
      state: null,
    };
    const store: AgentControlStore = {
      memberRole: async () => "owner",
      get: async () => structuredClone(controlAgent),
      replace: async (before, state) => {
        if (JSON.stringify(before.state) !== JSON.stringify(controlAgent.state)) return false;
        controlAgent = { ...controlAgent, state };
        return true;
      },
    };
    let releasePublish = () => {};
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let notifyPublished = () => {};
    const publishedSignal = new Promise<void>((resolve) => {
      notifyPublished = resolve;
    });
    const published: Uint8Array[] = [];
    const control = new AgentControl(
      store,
      {
        publish: async (_channel, bytes) => {
          published.push(bytes);
          notifyPublished();
          // Never resolves during this test: proves recoverWorkspace does not await it.
          await publishGate;
        },
      },
      { run: async (_id, work) => work() },
      { timeoutMs: 0, fallbackMs: 0 },
    );
    const recovery = new WorkspaceAgentRecovery(
      {
        getById: async (id) => agents.find((agent) => agent.id === id),
        listOwnedInWorkspace: async () => [],
        listInWorkspace: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        update: async () => {
          throw new Error("not used");
        },
        listForComputer: async () => agents.map((agent) => structuredClone(agent)),
      },
      {
        readAgentRecoveryContext: async () => ({ resumeMessages: [], unreadSummary: {} }),
        readPendingAgentDeliveries: async () => [],
      },
      {
        publish: async () => {
          throw new Error("must reconcile through AgentControl.publishStop, not this api");
        },
      },
      { run: async (_agentId, callback) => callback() },
      undefined,
      control,
    );

    // Proves the reconcile Stop does not block recovery: `publish` above never resolves
    // (`publishGate` is only released below), yet `recoverWorkspace` still completes.
    await recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-stopped-running"]);
    await publishedSignal;

    expect(published).toHaveLength(1);
    expect(decodeAgentStopIntent(published[0]!)).toMatchObject({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-stopped-running",
    });
    releasePublish();
  });

  test("publishes an Agent start when optional model and reasoning are empty", async () => {
    const payloads: Uint8Array[] = [];
    const channels: string[] = [];
    const useCase = new PublishAgentRuntimeControl(
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

    expect(channels).toEqual(["daemon:workspace-1:computer-1"]);
    expect(decodeAgentStartIntent(payloads[0]!)).toMatchObject({ model: "", reasoning: "" });
  });

  test("derives the start target from the authorized Agent and routes scoped activity", async () => {
    const published: Uint8Array[] = [];
    const activities: unknown[] = [];
    const useCase = new PublishAgentRuntimeControl(
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
    expect(decodeAgentStartIntent(published[0]!)).toMatchObject({
      computerId: "computer-1",
    });
    await useCase.receiveActivity(
      encodeAgentActivity({
        protocolMajor: 1,
        requestId: "e",
        workspaceId: "w",
        agentId: "a",
        detailKind: "starting",
        level: "info",
        detail: "started",
        observedAtMs: Date.parse("2026-08-27T00:00:00.000Z"),
        launchId: "launch-1",
        clientSeq: 1,
      }),
      { workspaceId: "w", agentId: "a" },
    );
    expect(published).toHaveLength(1);
    expect(activities).toHaveLength(1);
  });

  test("rejects an activity for another agent", async () => {
    const useCase = new PublishAgentRuntimeControl(
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
          detailKind: "runtime_error",
          level: "error",
          detail: "failed",
          observedAtMs: Date.parse("2026-08-27T00:00:00.000Z"),
          launchId: "launch-1",
          clientSeq: 1,
        }),
        { workspaceId: "w", agentId: "other" },
      ),
    ).rejects.toThrow("scope");
  });

  test("publishes an authorized Agent stop with only identity fields", async () => {
    const payloads: Uint8Array[] = [];
    const useCase = new PublishAgentRuntimeControl(
      { computerIdForAuthorizedAgent: async () => "computer-1" },
      {
        publish: async (_channel, payload) => {
          payloads.push(payload);
        },
      },
      async () => {},
    );
    await useCase.stop(
      {
        protocolMajor: 1,
        requestId: "stop-1",
        workspaceId: "workspace-1",
        computerId: "forged",
        agentId: "agent-1",
      },
      "user-1",
    );
    expect(decodeAgentStopIntent(payloads[0]!)).toEqual(
      expect.objectContaining({ computerId: "computer-1", agentId: "agent-1" }),
    );
    const denied = new PublishAgentRuntimeControl(
      { computerIdForAuthorizedAgent: async () => undefined },
      { publish: async () => {} },
      async () => {},
    );
    await expect(
      denied.stop(
        {
          protocolMajor: 1,
          requestId: "x",
          workspaceId: "w",
          computerId: "c",
          agentId: "a",
        },
        "u",
      ),
    ).rejects.toThrow("authorized");
  });
});
