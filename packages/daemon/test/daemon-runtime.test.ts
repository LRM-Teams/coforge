import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime } from "../src/daemon-runtime/runtime";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  UsageUnavailableError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type AgentDriver,
  type AgentSession,
} from "../src/code-agent/contract";
import type { WorkspaceConfig } from "../src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";
import { startAgentProxy, type AgentProxy } from "../src/agent-proxy";
import type { AgentMessageRequest, CloudAgentMessageResponse } from "@coforge/protocol";

function sessionSpy() {
  return {
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies AgentSession;
}

const workspaceRoot = join(tmpdir(), `coforge-daemon-runtime-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

test("ready and reconnect snapshots report the executable version and observed OS", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let snapshot: (() => import("@coforge/protocol").DaemonRuntimeReadyRequest) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready(get) {
          snapshot = get;
        },
      }),
    },
    undefined,
    async () => ({ runtimes: [], catalogs: [] }),
    workspaceRoot,
    {},
    "9.8.7",
  );
  try {
    await runtime.start(connection);
    const first = snapshot!();
    expect(first.computerVersion).toBe("9.8.7");
    expect(first.platform).toBe(process.platform);
    expect(first.osVersion).toBeTruthy();
    const reconnect = snapshot!();
    expect(reconnect.computerVersion).toBe("9.8.7");
    expect(reconnect.osVersion).toBe(first.osVersion);
    expect(reconnect.requestId).not.toBe(first.requestId);
  } finally {
    await runtime.stop();
  }
});

test("a duplicate fenced start wakes the managed runtime without replaying recovery context", async () => {
  const stateDirectory = join(tmpdir(), `coforge-managed-wake-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const notices: string[] = [];
  let sessions = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        return {
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
          readSessionIdentity: async () => ({ sessionId: "session-a", state: "resumable" }),
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
        async sendAgentControlResult() {},
        async reportAgentSession() {},
      }),
    },
    undefined,
    async () => ({ runtimes: [], catalogs: [] }),
    stateDirectory,
  );
  const intent = {
    protocolMajor: 1,
    requestId: "managed-start",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "managed-agent",
    ...config,
    controlEpoch: 1,
  };
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    await runtime.handleAgentStart({
      ...intent,
      wakeMessage: {
        messageId: "wake-message",
        deliveryId: "wake-delivery",
        conversationId: "conversation-a",
        sequence: 2,
        target: "@ada",
        latestSender: "@ada",
        body: "wake only",
      },
      resumeMessages: [
        {
          messageId: "resume-message",
          deliveryId: "resume-delivery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "must be ignored",
        },
      ],
      unreadSummary: { "@grace": 4 },
    });
    expect(sessions).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("wake only");
    expect(notices[0]).not.toContain("must be ignored");
    expect(notices[0]).not.toContain("@grace");
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a recreated daemon waits for cloud start and forwards the cloud-selected session", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const sessions: Array<string | undefined> = [];
  const modes: Array<string | undefined> = [];
  const make = () =>
    new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          sessions.push(options.sessionId);
          modes.push(options.sessionMode);
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
        }),
      },
      undefined,
      async () => ({ runtimes: [], catalogs: [] }),
    );
  const original = make();
  await original.start(connection);
  expect(sessions).toEqual([]);
  await original.handleAgentStart({
    protocolMajor: 1,
    requestId: "first",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "cloud-agent",
    ...config,
    sessionId: "cloud-first",
    sessionMode: "create",
  });
  await original.stop();
  const recreated = make();
  try {
    await recreated.start(connection);
    expect(sessions).toEqual(["cloud-first"]);
    await recreated.handleAgentStart({
      protocolMajor: 1,
      requestId: "second",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "cloud-agent",
      ...config,
      sessionId: "cloud-selected",
      sessionMode: "resume",
    });
    expect(sessions).toEqual(["cloud-first", "cloud-selected"]);
    expect(modes).toEqual(["create", "resume"]);
  } finally {
    await original.stop();
    await recreated.stop();
  }
});

test("returned identity is acknowledged before Agent readiness and retired callbacks are rejected", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const reported = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  let callback: ((id: string) => Promise<void>) | undefined;
  const reports: import("@coforge/protocol").AgentSessionReport[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(options) {
        callback = options.onSessionId;
        await callback!("returned-session");
        return sessionSpy();
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async reportAgentSession(report) {
          reports.push(report);
          reported.resolve();
          await acknowledged.promise;
        },
      }),
    },
  );
  try {
    await runtime.start(connection);
    let ready = false;
    const launch = runtime
      .handleAgentStart({
        protocolMajor: 1,
        requestId: "cloud-start",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "reported-agent",
        ...config,
      })
      .then(() => {
        ready = true;
      });
    await reported.promise;
    expect(ready).toBe(false);
    expect(reports[0]).toMatchObject({
      startRequestId: "cloud-start",
      sessionId: "returned-session",
      agentId: "reported-agent",
    });
    acknowledged.resolve();
    await launch;
    await runtime.stop();
    await expect(callback!("late-session")).rejects.toThrow("superseded");
    expect(reports).toHaveLength(1);
  } finally {
    acknowledged.resolve();
    await runtime.stop();
  }
});

test("cloud-authorized wake restores the acknowledged identity with a successor launch fence", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const exits: Array<() => void> = [];
  const selected: Array<string | undefined> = [];
  const callbacks: Array<(id: string) => Promise<void>> = [];
  const reports: import("@coforge/protocol").AgentSessionReport[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(options) {
        selected.push(options.sessionId);
        callbacks.push(options.onSessionId!);
        await options.onSessionId!("returned-session");
        return {
          ...sessionSpy(),
          onExit(listener: () => void) {
            exits.push(listener);
            return () => {};
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async reportAgentSession(report) {
          reports.push(report);
          if (reports.length === 3) throw new Error("session ACK lost");
        },
      }),
    },
  );
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "cloud-start",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-agent",
      ...config,
    });
    for (const exit of exits.splice(0)) exit();
    await runtime.startAgent("wake-agent", config);
    expect(selected).toEqual([undefined, "returned-session"]);
    expect(reports[1]).toMatchObject({
      startRequestId: "cloud-start",
      previousLaunchId: reports[0]!.launchId,
    });
    expect(reports[1]!.launchId).not.toBe(reports[0]!.launchId);
    await expect(callbacks[0]!("late-old-session")).rejects.toThrow("superseded");
    expect(reports).toHaveLength(2);
    for (const exit of exits.splice(0)) exit();
    await expect(runtime.startAgent("wake-agent", config)).rejects.toThrow("session ACK lost");
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "cloud-start",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-agent",
      ...config,
      sessionId: "returned-session",
      previousLaunchId: reports[2]!.launchId,
    });
    expect(reports[3]!.previousLaunchId).toBe(reports[2]!.launchId);
  } finally {
    await runtime.stop();
  }
});

function messageRecord(
  sequence: number,
  sender: string,
  target: string,
  id = `message-${sequence}`,
) {
  return {
    id,
    sequence,
    sender,
    target,
    body: `body-${sequence}`,
    createdAt: "2026-09-03T00:00:00Z",
  };
}

function agentLaunchConfig(
  agentApiKey: string,
  providerConfig?: AgentRuntimeConfig["providerConfig"],
) {
  return { agentApiKey, providerConfig };
}

async function queueHarness(
  options: {
    credential?: Promise<string>;
    launch?: () => void | Promise<void>;
    notify?: (notice: string) => void | Promise<void>;
    dispose?: () => void | Promise<void>;
    lifecycle?: (event: string) => void;
    activity?: (activity: import("@coforge/protocol").AgentActivity) => void;
  } = {},
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  let sessions = 0;
  let mints = 0;
  let readyFactory: (() => { runningAgentIds: string[] }) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        await options.launch?.();
        sessions++;
        return {
          ...sessionSpy(),
          async notify(notice: string) {
            notices.push(notice);
            await options.notify?.(notice);
          },
          async dispose() {
            await options.dispose?.();
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready(createRequest) {
          readyFactory = createRequest;
        },
        async stop() {},
        async requestAgentLaunchConfig() {
          mints++;
          return agentLaunchConfig(
            options.credential ? await options.credential : `sk_agent_${"a".repeat(43)}`,
          );
        },
        async revokeAgentApiKey() {},
        sendAgentStatus(status) {
          options.lifecycle?.(`status:${status.status}`);
        },
        sendAgentActivity(activity) {
          options.lifecycle?.(`activity:${activity.detailKind}`);
          options.activity?.(activity);
        },
        async sendAgentDeliveryAck(ack) {
          acknowledgements.push(ack.deliveryId);
          options.lifecycle?.(`ack:${ack.deliveryId}`);
        },
      }),
    },
  );
  await runtime.start(connection);
  return {
    runtime,
    notices,
    acknowledgements,
    sessions: () => sessions,
    mints: () => mints,
    runningAgentIds: () => readyFactory!().runningAgentIds,
    delivery: (sequence: number) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `request-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "private",
        method: "agent:deliver",
        target: "@ada",
      }),
  };
}

async function messageHarness(
  respond: (request: AgentMessageRequest) => Promise<CloudAgentMessageResponse>,
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async revokeAgentApiKey() {},
        async sendAgentDeliveryAck() {},
        agentMessage: respond,
      }),
    },
    undefined,
    async () => ({ runtimes: [], catalogs: [] }),
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  return {
    runtime,
    context: runtime.issueAgentContext("agent-a"),
    apiKey: `sk_agent_${"a".repeat(43)}`,
    deliver: (sequence: number, target: string) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `delivery-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: `body-${sequence}`,
        method: "agent:deliver",
        target,
      }),
  };
}

const recovery = {
  resumeMessages: [],
  unreadSummary: { "@ada": 1 },
};

test("channel check and notification settings use the bound Agent without replacing its session", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      requestId: request.requestId,
      accepted: true,
      attentionCount: 0,
      messages:
        request.operation === "read"
          ? [messageRecord(1, "@alice", "#general"), messageRecord(3, "@bob", "#general")]
          : [],
    };
  });
  try {
    await harness.deliver(1, "#general");
    await harness.deliver(3, "#general");
    const checked = await harness.runtime.agentMessage(
      harness.context,
      { requestId: "channel-check", context: harness.context, operation: "check" },
      harness.apiKey,
    );
    expect(checked.messages.map((m) => m.sender)).toEqual(["@alice", "@bob"]);
    for (const operation of ["mute", "unmute"] as const)
      await harness.runtime.agentMessage(
        harness.context,
        { requestId: operation, context: harness.context, operation, target: "#general" },
        harness.apiKey,
      );
    await harness.runtime.agentMessage(
      harness.context,
      {
        requestId: "thread-unfollow",
        context: harness.context,
        operation: "thread-unfollow",
        target: "#general:12345678-0000-4000-8000-000000000001",
      },
      harness.apiKey,
    );
    expect(
      calls.slice(-3).map(({ operation, target, agentId }) => [operation, target, agentId]),
    ).toEqual([
      ["mute", "#general", "agent-a"],
      ["unmute", "#general", "agent-a"],
      ["thread-unfollow", "#general:12345678-0000-4000-8000-000000000001", "agent-a"],
    ]);
  } finally {
    await harness.runtime.stop();
  }
});

describe("DaemonRuntime", () => {
  test("orders stop completion before replacement start lifecycle", async () => {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const lifecycle: string[] = [];
    const harness = await queueHarness({
      dispose: () => disposeGate,
      lifecycle: (event) => lifecycle.push(event),
    });
    const intent = {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await harness.runtime.handleAgentStart(intent);

    const stopping = harness.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
    });
    const restarting = harness.runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    await Bun.sleep(0);
    expect(harness.sessions()).toBe(1);
    expect(lifecycle).toEqual(["status:active", "activity:starting"]);

    releaseDispose();
    await Promise.all([stopping, restarting]);
    expect(harness.sessions()).toBe(2);
    expect(lifecycle).toEqual([
      "status:active",
      "activity:starting",
      "status:inactive",
      "activity:stopped",
      "status:active",
      "activity:starting",
    ]);
    await harness.runtime.stop();
  });

  test("does not control-start a replacement when the same Agent stop fails", async () => {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const harness = await queueHarness({
      async dispose() {
        await disposeGate;
        throw new Error("dispose failed");
      },
    });
    const intent = {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await harness.runtime.handleAgentStart(intent);

    const stopping = harness.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
    });
    const restarting = harness.runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    const results = Promise.allSettled([stopping, restarting]);
    releaseDispose();
    expect(await results).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.any(Error) }),
      expect.objectContaining({ status: "rejected", reason: expect.any(Error) }),
    ]);
    expect(harness.sessions()).toBe(1);
    await harness.runtime.stop().catch(() => undefined);
  });

  test.each(["@ada", "@ada:12345678"])(
    "message check drains exact target %s in one session",
    async (target) => {
      const rootId = "12345678-1234-4234-8234-123456789abc";
      const canonicalTarget = target.includes(":") ? `@ada:${rootId}` : target;
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      let reads = 0;
      let launches = 0;
      const requests: Array<{ before?: string; around?: string; limit?: number }> = [];
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "pi",
          createAgentSession: async () => {
            launches++;
            return { ...sessionSpy(), async notify() {} };
          },
        }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            async requestAgentApiKey() {
              return `sk_agent_${"a".repeat(43)}`;
            },
            async revokeAgentApiKey() {},
            async sendAgentDeliveryAck() {},
            async agentMessage(request) {
              if (
                target.includes(":") &&
                request.target === "@ada" &&
                request.around === "12345678"
              )
                return {
                  protocolMajor: 1,
                  requestId: request.requestId,
                  accepted: true,
                  attentionCount: 0,
                  messages: [
                    {
                      id: rootId,
                      sequence: 1,
                      sender: "@ada",
                      target: "@ada",
                      body: "root",
                      createdAt: "2026-09-03T00:00:00Z",
                    },
                  ],
                };
              reads++;
              requests.push(request);
              return {
                protocolMajor: 1,
                requestId: request.requestId,
                accepted: true,
                attentionCount: 1,
                messages: [
                  {
                    id: "message-5",
                    sequence: 5,
                    sender: "@ada",
                    target: canonicalTarget,
                    body: "old message",
                    createdAt: "2026-09-03T00:00:00Z",
                  },
                  {
                    id: "message-7",
                    sequence: 7,
                    sender: "@ada",
                    target: canonicalTarget,
                    body: "new message",
                    createdAt: "2026-09-03T00:01:00Z",
                  },
                ],
              };
            },
          }),
        },
      );
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const context = runtime.issueAgentContext("agent-a");
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "delivery-request",
        messageId: "message-7",
        deliveryId: "delivery-7",
        sequence: 7,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "new message",
        method: "agent:deliver",
        target: canonicalTarget,
      });

      const first = await runtime.agentMessage(
        context,
        { requestId: "check-1", context, operation: "check" },
        `sk_agent_${"a".repeat(43)}`,
      );
      const second = await runtime.agentMessage(
        context,
        { requestId: "check-2", context, operation: "check" },
        `sk_agent_${"a".repeat(43)}`,
      );

      expect(first.messages.map(({ id }) => id)).toEqual(["message-5", "message-7"]);
      expect(second.messages).toEqual([]);
      expect(reads).toBe(1);
      await runtime.agentMessage(
        context,
        { requestId: "history", context, operation: "read", target, around: "12345678", limit: 1 },
        `sk_agent_${"a".repeat(43)}`,
      );
      expect(requests.at(-1)).toMatchObject({ around: "12345678", limit: 1 });
      expect(launches).toBe(1);
      await runtime.stop();
    },
  );

  test("uses the full target and short-read position when sending to a short thread target", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const fullTarget = `@ada:${rootId}`;
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      if (request.target === "@ada")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "@ada", rootId)],
        };
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: request.operation === "send" ? "sent" : undefined,
        messages: request.operation === "read" ? [messageRecord(7, "@ada", fullTarget)] : [],
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "read-short",
          context: harness.context,
          operation: "read",
          target: "@ada:12345678",
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-short",
          context: harness.context,
          operation: "send",
          target: "@ada:12345678",
          body: "reply",
        },
        harness.apiKey,
      );
      expect(requests.at(-1)).toMatchObject({
        operation: "send",
        target: fullTarget,
        seenUpToSequence: 7,
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("resolves a short channel thread target through its parent channel", async () => {
    const rootId = "abcdef12-1234-4234-8234-123456789abc";
    const fullTarget = `#general:${rootId}`;
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      if (request.target === "#general")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "#general", rootId)],
        };
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: request.operation === "send" ? "sent" : undefined,
        messages: [],
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-channel-thread",
          context: harness.context,
          operation: "send",
          target: "#general:abcdef12",
          body: "thread reply",
        },
        harness.apiKey,
      );
      expect(requests.at(-1)).toMatchObject({
        operation: "send",
        target: fullTarget,
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("reuses a short-target held draft token and body when sent with the full target", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const fullTarget = `@ada:${rootId}`;
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.target === "@ada")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "@ada", rootId)],
        };
      sends.push(request);
      return sends.length === 1
        ? {
            protocolMajor: 1,
            requestId: request.requestId,
            accepted: false,
            attentionCount: 1,
            messages: [],
            sideEffectDecision: "hold",
            holdToken: "opaque-token",
          }
        : {
            protocolMajor: 1,
            requestId: request.requestId,
            accepted: true,
            attentionCount: 0,
            messageId: "sent",
            messages: [],
            sideEffectDecision: "forward",
          };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "hold-short",
          context: harness.context,
          operation: "send",
          target: "@ada:12345678",
          body: "original body",
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-full-draft",
          context: harness.context,
          operation: "send",
          target: fullTarget,
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({
        target: fullTarget,
        body: "original body",
        holdToken: "opaque-token",
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("an empty read clears only attention that existed when the read started", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let markReadEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => (markReadEntered = resolve));
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read" && request.requestId === "held-read") {
        markReadEntered();
        await readGate;
      }
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messages:
          request.requestId === "check-after-race" ? [messageRecord(9, "@ada", "@ada")] : [],
      };
    });
    try {
      await harness.deliver(7, "@ada");
      const reading = harness.runtime.agentMessage(
        harness.context,
        { requestId: "held-read", context: harness.context, operation: "read", target: "@ada" },
        harness.apiKey,
      );
      await readEntered;
      await harness.deliver(9, "@ada");
      releaseRead();
      await reading;
      const pending = await harness.runtime.agentMessage(
        harness.context,
        { requestId: "check-after-race", context: harness.context, operation: "check" },
        harness.apiKey,
      );
      expect(pending.summaries).toEqual([
        expect.objectContaining({ target: "@ada", latestSequence: 9 }),
      ]);
    } finally {
      releaseRead();
      await harness.runtime.stop();
    }
  });

  test.each([
    ["rejected", false, []],
    ["wrong-target", true, [messageRecord(7, "@bea", "@bea")]],
  ])("a %s read result does not clear target attention", async (_case, accepted, messages) => {
    const harness = await messageHarness(async (request) => ({
      protocolMajor: 1,
      requestId: request.requestId,
      accepted,
      attentionCount: 1,
      messages:
        request.requestId === "check-preserved" ? [messageRecord(7, "@ada", "@ada")] : messages,
    }));
    try {
      await harness.deliver(7, "@ada");
      await harness.runtime.agentMessage(
        harness.context,
        { requestId: "read-result", context: harness.context, operation: "read", target: "@ada" },
        harness.apiKey,
      );
      const pending = await harness.runtime.agentMessage(
        harness.context,
        { requestId: "check-preserved", context: harness.context, operation: "check" },
        harness.apiKey,
      );
      expect(pending.summaries).toEqual([expect.objectContaining({ target: "@ada" })]);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("message check returns every user message in the canonical page despite later attention", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const ranges: Array<number | undefined> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            ranges.push(request.fromSequence);
            const sequences = request.fromSequence === undefined ? [1, 2] : [3];
            return {
              protocolMajor: 1,
              requestId: request.requestId,
              accepted: true,
              attentionCount: 1,
              hasNewer: sequences.at(-1)! < 3,
              messages: sequences.map((sequence) => ({
                id: `message-${sequence}`,
                sequence,
                sender: sequence === 2 ? "@agent-a" : "@ada",
                target: "@ada",
                body: `body-${sequence}`,
                createdAt: "2026-09-03T00:00:00Z",
              })),
            };
          },
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-3",
      messageId: "message-3",
      deliveryId: "delivery-3",
      sequence: 3,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "body-3",
      method: "agent:deliver",
      target: "@ada",
    });
    const context = runtime.issueAgentContext("agent-a");
    const result = await runtime.agentMessage(
      context,
      { requestId: "check-range", context, operation: "check", limit: 2 },
      `sk_agent_${"a".repeat(43)}`,
    );

    expect(ranges).toEqual([undefined, 3]);
    expect(result.messages.map(({ sequence }) => sequence)).toEqual([1, 3]);
    await runtime.stop();
  });

  test("preserves a server-held draft and returns its opaque token only to the server", async () => {
    const stateDirectory = join(tmpdir(), `coforge-message-drafts-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const operations: string[] = [];
    const messageRequests: Array<{ requestId: string; holdToken?: string }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            operations.push(request.operation);
            messageRequests.push({ requestId: request.requestId, holdToken: request.holdToken });
            return request.requestId === "send-1"
              ? {
                  protocolMajor: 1,
                  requestId: request.requestId,
                  accepted: false,
                  attentionCount: 1,
                  sideEffectDecision: "hold" as const,
                  holdToken: "server-opaque-token",
                  messages: [
                    {
                      id: "message-7",
                      sequence: 7,
                      sender: "@ada",
                      target: "@agent",
                      body: "new context",
                      createdAt: "2026-09-03T00:00:00Z",
                    },
                  ],
                }
              : {
                  protocolMajor: 1,
                  requestId: request.requestId,
                  accepted: true,
                  attentionCount: 0,
                  messageId: "sent",
                  messages: [],
                  sideEffectDecision: "forward" as const,
                };
          },
        }),
      },
      undefined,
      async () => ({ runtimes: [], catalogs: [] }),
      stateDirectory,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-request",
      messageId: "message-7",
      deliveryId: "delivery-7",
      sequence: 7,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "new context",
      method: "agent:deliver",
      target: "@ada",
    });

    const held = await runtime.agentMessage(
      context,
      { requestId: "send-1", context, operation: "send", target: "@ada", body: "reply" },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(held).toMatchObject({
      accepted: false,
      sideEffectDecision: "hold",
      messages: [{ id: "message-7" }],
    });
    expect(held).not.toHaveProperty("seenUpToSequence");
    expect(held).not.toHaveProperty("holdToken");
    expect(operations).toEqual(["send"]);
    expect(messageRequests).toEqual([{ requestId: "send-1" }]);

    await runtime.stop();
    const recoveredRuntime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"b".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            operations.push(request.operation);
            messageRequests.push({ requestId: request.requestId, holdToken: request.holdToken });
            return {
              protocolMajor: 1,
              requestId: request.requestId,
              accepted: true,
              attentionCount: 0,
              messageId: "sent",
              messages: [],
              sideEffectDecision: "forward" as const,
            };
          },
        }),
      },
      undefined,
      async () => ({ runtimes: [], catalogs: [] }),
      stateDirectory,
    );
    await recoveredRuntime.start(connection);
    await recoveredRuntime.startAgent("agent-a", config);
    const recoveredContext = recoveredRuntime.issueAgentContext("agent-a");

    const sent = await recoveredRuntime.agentMessage(
      recoveredContext,
      {
        requestId: "send-2",
        context: recoveredContext,
        operation: "send",
        target: "@ada",
        sendDraft: true,
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(sent).toMatchObject({ accepted: true, sideEffectDecision: "forward" });
    expect(operations).toEqual(["send", "send"]);
    expect(messageRequests).toEqual([
      { requestId: "send-1" },
      { requestId: "send-2", holdToken: "server-opaque-token" },
    ]);

    await expect(
      recoveredRuntime.agentMessage(
        recoveredContext,
        {
          requestId: "send-cleared",
          context: recoveredContext,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        `sk_agent_${"a".repeat(43)}`,
      ),
    ).rejects.toThrow("No held draft");

    const ordinarySend = await recoveredRuntime.agentMessage(
      recoveredContext,
      {
        requestId: "send-3",
        context: recoveredContext,
        operation: "send",
        target: "@ada",
        body: "follow-up",
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(ordinarySend).toMatchObject({ accepted: true, sideEffectDecision: "forward" });
    expect(operations).toEqual(["send", "send", "send"]);
    expect(messageRequests.at(-1)).toEqual({ requestId: "send-3", holdToken: undefined });
    await recoveredRuntime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test("keeps an Agent active without a process, wakes it for a message, and deactivates it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const statuses: import("@coforge/protocol").AgentStatus[] = [];
    const notices: string[] = [];
    const acknowledgements: string[] = [];
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
          onExit(listener) {
            exits.add(listener);
            return () => exits.delete(listener);
          },
        }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus(status) {
            statuses.push(status);
          },
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async requestAgentApiKey() {
            starts++;
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
    );

    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    expect(statuses.map(({ agentId, status }) => ({ agentId, status }))).toEqual([
      { agentId: "agent-a", status: "active" },
    ]);

    for (const exit of exits) exit();
    expect(statuses.map(({ agentId, status }) => ({ agentId, status }))).toEqual([
      { agentId: "agent-a", status: "active" },
    ]);
    expect(runtime.agentProcessManager.session("agent-a")).toBeUndefined();

    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "message-request-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-1",
      agentId: "agent-a",
      body: "private body",
      method: "agent:deliver",
      target: "@agent",
    });
    expect(starts).toBe(2);
    expect(notices).toEqual([
      "[CoForge inbox notice:\nInbox update: 1 unread message total; 1 changed target\n@agent  pending: 1 message\nRun `coforge message check` to read pending messages.]",
    ]);
    expect(acknowledgements).toEqual(["delivery-1"]);

    await runtime.stopAgent("agent-a");
    expect(statuses.at(-1)?.status).toBe("inactive");
    await runtime.stop();
  });

  test("reports active Agents inactive before a graceful daemon shutdown", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const statuses: import("@coforge/protocol").AgentStatus[] = [];
    let statusAtTransportStop: string | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus(status) {
            statuses.push(status);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {
            statusAtTransportStop = statuses.at(-1)?.status;
          },
        }),
      },
    );

    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    await Bun.sleep(2);
    await runtime.stop();

    expect(statuses.map(({ status }) => status)).toEqual(["active", "inactive"]);
    expect(new Set(statuses.map(({ observedAtMs }) => observedAtMs)).size).toBe(1);
    expect(statusAtTransportStop).toBe("inactive");
  });

  test("reports a fresh external Code Agent snapshot on daemon start", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const updates: unknown[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async updateCodeAgents(request) {
            updates.push(request);
          },
          async stop() {},
        }),
      },
      undefined,
      async () => ({
        runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        catalogs: [{ provider: "codex", models: [] }],
      }),
    );

    await runtime.start(connection);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      catalogs: [{ provider: "codex", models: [] }],
    });
    await runtime.stop();
  });

  test("falls back to a current Claude rate-limit observation when direct usage is unavailable", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const adapter: AgentDriver = {
      provider: "claude-code",
      async readUsage() {
        return null;
      },
      async createAgentSession() {
        return {
          ...sessionSpy(),
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
      },
    };
    const runtime = new DaemonRuntime(connection, () => adapter, credentials, {
      create: () => ({
        async start() {},
        async ready() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async stop() {},
      }),
    });
    await runtime.start(connection);
    await runtime.startAgent("agent-a", {
      provider: "claude-code",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
    for (const listener of listeners)
      listener({
        type: AGENT_RUNTIME_EVENT_TYPE.USAGE,
        snapshot: {
          provider: "claude-code",
          primary: {
            status: "available",
            windowDurationMinutes: 300,
            resetsAt: "2099-09-04T03:00:00.000Z",
          },
        },
      });

    const result = await runtime.scanUsage("claude-code");
    expect(result.status).toBe("available");
    expect(JSON.parse(new TextDecoder().decode(result.snapshotJson))).toEqual({
      provider: "claude-code",
      primary: {
        status: "available",
        windowDurationMinutes: 300,
        resetsAt: "2099-09-04T03:00:00.000Z",
      },
    });
    await runtime.stop();
  });

  test("scans Kiro quota and distinguishes an unrepresentable window from expired authentication", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const snapshot = {
      provider: "kiro" as const,
      primary: {
        usedPercent: 37,
        windowDurationMinutes: 43200,
        resetsAt: "2026-10-01T00:00:00.000Z",
      },
    };
    let outcome: "available" | "unavailable" | "reauth" = "available";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "kiro",
        async readUsage() {
          if (outcome === "unavailable") throw new UsageUnavailableError();
          if (outcome === "reauth") return null;
          return snapshot;
        },
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
    );
    await runtime.start(connection);
    try {
      const result = await runtime.scanUsage("kiro");
      expect(result.status).toBe("available");
      expect(JSON.parse(new TextDecoder().decode(result.snapshotJson))).toEqual(snapshot);
      outcome = "unavailable";
      expect((await runtime.scanUsage("kiro")).status).toBe("unavailable");
      outcome = "reauth";
      expect((await runtime.scanUsage("kiro")).status).toBe("reauth");
    } finally {
      await runtime.stop();
    }
  });

  test("does not expose a usage driver exception in the scan response", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "codex",
        async readUsage() {
          throw new Error("provider token secret at 127.0.0.1");
        },
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
        }),
      },
    );
    await runtime.start(connection);

    const result = await runtime.scanUsage("codex");
    expect(result).toMatchObject({ status: "error", message: "Usage scan failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    await runtime.stop();
  });

  test("passes the persisted server HTTP URL to the Agent API key client", async () => {
    const configuredConnection = {
      ...connection,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "daemon-token");
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ apiKey: `sk_agent_${"a".repeat(43)}` });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = connectedClient();
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => new DaemonConnection("wss://cloud.example", () => client),
      },
    );
    try {
      await runtime.start(configuredConnection);
      await runtime.startAgent("agent-a", config);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "https://server.example/api/agent-api-keys",
        authorization: "Bearer daemon-token",
      },
    ]);
  });

  test("shares concurrent starts and starts transport once", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            starts++;
            await gate;
          },
          async ready() {},
          async stop() {},
        }),
      },
    );

    const first = runtime.start(connection);
    const second = runtime.start(connection);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    await runtime.start(connection);
    expect(starts).toBe(1);
    await runtime.stop();
  });

  test("starts all ready publications without blocking other Agents on a slow launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const startedAgents: string[] = [];
    let releaseFirstCredential!: () => void;
    const firstCredential = new Promise<void>((resolve) => (releaseFirstCredential = resolve));
    let secondAgentActive!: () => void;
    const secondActive = new Promise<void>((resolve) => (secondAgentActive = resolve));
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(input) {
          startedAgents.push(input.sessionId ?? "");
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
          async ready() {
            listener?.({
              protocolMajor: 1,
              requestId: "ready-publication-1",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-a",
            });
            listener?.({
              protocolMajor: 1,
              requestId: "ready-publication-2",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-b",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-b",
            });
          },
          async requestAgentLaunchConfig({ agentId }) {
            if (agentId === "agent-a") await firstCredential;
            return agentLaunchConfig(
              `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
            );
          },
          sendAgentStatus({ agentId, status }) {
            if (agentId === "agent-b" && status === "active") secondAgentActive();
          },
          async sendAgentActivity() {},
          async stop() {},
        }),
      },
    );

    const starting = runtime.start(connection);
    try {
      await secondActive;
      expect(startedAgents).toEqual(["session-b"]);
      releaseFirstCredential();
      await starting;
      expect(startedAgents).toEqual(["session-b", "session-a"]);
    } finally {
      releaseFirstCredential();
      await starting;
      await runtime.stop();
    }
  });

  test("flushes buffered starts before delivery without losing starts received during flush", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let startListener:
      | ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void)
      | undefined;
    let messageListener:
      | ((message: Parameters<DaemonRuntime["handleAgentMessage"]>[0]) => void)
      | undefined;
    const events: string[] = [];
    let notifyStarted!: () => void;
    const notifying = new Promise<void>((resolve) => (notifyStarted = resolve));
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>((resolve) => (releaseNotify = resolve));
    let releaseSecondCredential!: () => void;
    const secondCredential = new Promise<void>((resolve) => (releaseSecondCredential = resolve));
    let secondAgentActive!: () => void;
    const secondActive = new Promise<void>((resolve) => (secondAgentActive = resolve));
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async ({ agentId }) => {
          events.push(`start:${agentId}`);
          return {
            ...sessionSpy(),
            async notify() {
              events.push(`notify:${agentId}`);
              notifyStarted();
              await notifyGate;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            startListener = callback;
            return () => {};
          },
          onAgentMessage(callback) {
            messageListener = callback;
            return () => {};
          },
          async ready() {
            messageListener?.({
              protocolMajor: 1,
              requestId: "delivery-1",
              messageId: "message-1",
              deliveryId: "delivery-1",
              sequence: 1,
              workspaceId: connection.workspaceId,
              conversationId: "conversation-a",
              agentId: "agent-a",
              body: "hello",
              method: "agent:deliver",
              target: "@ada",
            });
            startListener?.({
              protocolMajor: 1,
              requestId: "start-1",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
            });
          },
          async requestAgentLaunchConfig({ agentId }) {
            if (agentId === "agent-b") await secondCredential;
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          sendAgentStatus({ agentId, status }) {
            if (agentId === "agent-b" && status === "active") secondAgentActive();
          },
          async sendAgentDeliveryAck() {},
          async stop() {},
        }),
      },
    );

    const starting = runtime.start(connection);
    try {
      await notifying;
      startListener?.({
        protocolMajor: 1,
        requestId: "start-2",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-b",
        provider: "pi",
        model: "default",
        reasoning: "balanced",
      });
      releaseNotify();
      await starting;
      // Live starts received during the initial flush run independently. Wait
      // for the observable active status, not a timer tick or initial startup.
      expect(events).toEqual(["start:agent-a", "notify:agent-a"]);
      releaseSecondCredential();
      await secondActive;

      expect(events).toEqual(["start:agent-a", "notify:agent-a", "start:agent-b"]);
    } finally {
      releaseNotify();
      releaseSecondCredential();
      await starting;
      await runtime.stop();
    }
  });

  test("recreates transport after a failed start", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let created = 0;
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => {
          created++;
          const attempt = created;
          return {
            async start() {
              starts++;
              if (attempt === 1) throw new Error("start failed");
            },
            async ready() {},
            async stop() {},
          };
        },
      },
    );

    await expect(runtime.start(connection)).rejects.toThrow("start failed");
    await runtime.start(connection);
    expect(starts).toBe(2);
    expect(created).toBe(2);
    await runtime.stop();
  });

  test("removes startup listeners and buffered publications when ready fails", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    let unsubscribed = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            listener = callback;
            return () => {
              unsubscribed = true;
              listener = undefined;
            };
          },
          async ready() {
            listener?.({
              protocolMajor: 1,
              requestId: "discarded-publication",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-a",
            });
            throw new Error("ready failed");
          },
          async stop() {},
        }),
      },
    );

    await expect(runtime.start(connection)).rejects.toThrow("ready failed");
    expect(unsubscribed).toBe(true);
    expect(listener).toBeUndefined();
    expect(runtime.agentProcessManager.size).toBe(0);
  });

  test("releases Agent runtimes when transport stop fails", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let shutdownTransport = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async stop() {
            shutdownTransport = true;
            throw new Error("stop failed");
          },
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);

    await expect(runtime.stop()).rejects.toThrow("stop failed");
    expect(shutdownTransport).toBe(true);
    expect(runtime.agentProcessManager.size).toBe(0);
  });

  test("waits for an in-flight start before stopping the transport", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const entered = Promise.withResolvers<void>();
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            calls.push("start");
            entered.resolve();
            await started;
          },
          async ready() {},
          async stop() {
            calls.push("stop");
          },
        }),
      },
    );

    const starting = runtime.start(connection);
    const stopping = runtime.stop();
    await entered.promise;
    expect(calls).toEqual(["start"]);
    release();
    await Promise.all([starting, stopping]);
    expect(calls).toEqual(["start", "stop"]);
  });

  test("owns one AgentProcessManager for its workspace", async () => {
    const adapter: AgentDriver = {
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const transportCalls: unknown[] = [];
    const runtime = new DaemonRuntime(connection, () => adapter, credentials, {
      create: () => ({
        async start(token, config) {
          transportCalls.push([token, config]);
        },
        async ready() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async stop() {
          transportCalls.push("stop");
        },
      }),
    });

    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);

    expect(runtime.agentProcessManager.size).toBe(1);
    await runtime.stop();
    expect(runtime.agentProcessManager.size).toBe(0);
    expect(transportCalls).toEqual([
      [
        "token-a",
        {
          computerId: "computer-a",
          workspaceId: "workspace-a",
        },
      ],
      "stop",
    ]);
  });

  test("passes the runtime provider config to its driver without interpreting it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let startedCredential: unknown;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          startedCredential = options.runtime?.providerConfig;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`, {
              kind: "coforge",
              providerId: "deepseek",
              apiKey: "sk-deepseek-secret",
            });
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
    );

    await runtime.start(connection);
    await runtime.startAgent("agent-a", {
      provider: "pi",
      model: "deepseek-chat",
      modelProvider: "deepseek",
      reasoning: "high",
      providerConfig: {
        kind: "coforge",
        providerId: "deepseek",
        apiKey: "sk-deepseek-secret",
      },
    });

    expect(startedCredential).toEqual({
      kind: "coforge",
      providerId: "deepseek",
      apiKey: "sk-deepseek-secret",
    });
    await runtime.stop();
  });

  test("fails to start without a credential and can be retried", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            starts++;
          },
          async ready() {},
          async stop() {},
        }),
      },
    );

    await expect(runtime.start(connection)).rejects.toThrow("credential is missing");
    await credentials.save(connection.workspaceId, connection.computerId, "retry-token");
    await runtime.start(connection);
    expect(starts).toBe(1);
    await runtime.stop();
  });

  test("reports Message received after acceptance and before ACK, once per injection", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    const harness = await queueHarness({
      lifecycle: (event) => events.push(event),
      activity: (activity) => activities.push(activity),
      notify: async () => {
        entered.resolve();
        await gate.promise;
        events.push("accepted");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      events.length = 0;
      const delivery = harness.delivery(1);
      await entered.promise;
      expect(events).toEqual([]);
      gate.resolve();
      await delivery;
      expect(events).toEqual(["accepted", "activity:model_request_started", "ack:delivery-1"]);
      expect(activities[1]).toMatchObject({
        agentId: "agent-a",
        detailKind: "model_request_started",
        detail: "Message received",
        level: "info",
        entries: [],
        launchId: activities[0]!.launchId,
        clientSeq: activities[0]!.clientSeq + 1,
      });
      await harness.delivery(1);
      expect(activities).toHaveLength(2);
      expect(harness.notices).toHaveLength(1);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });

  test.each(["wake", "resume", "summary"])(
    "reports accepted %s recovery only for concrete messages",
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const activities: import("@coforge/protocol").AgentActivity[] = [];
      const harness = await queueHarness({
        activity: (activity) => activities.push(activity),
        notify: async () => {
          entered.resolve();
          await gate.promise;
        },
      });
      const message = {
        messageId: "recovery-message",
        deliveryId: "recovery-delivery",
        conversationId: "conversation-a",
        sequence: 1,
        target: "@ada",
        latestSender: "@ada",
        body: "hello",
      };
      try {
        const launch = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
          ...(kind === "wake" ? { wakeMessage: message } : {}),
          resumeMessages: kind === "resume" ? [message] : [],
          unreadSummary: { "@ada": 3 },
        });
        await entered.promise;
        expect(activities.map((activity) => activity.detailKind)).toEqual(["starting"]);
        gate.resolve();
        await launch;
        expect(activities.map((activity) => activity.detailKind)).toEqual(
          kind === "summary" ? ["starting"] : ["starting", "model_request_started"],
        );
        if (kind !== "summary") {
          expect(activities[1]).toMatchObject({
            agentId: "agent-a",
            detailKind: "model_request_started",
            detail: "Message received",
            level: "info",
            entries: [],
            launchId: activities[0]!.launchId,
            clientSeq: activities[0]!.clientSeq + 1,
          });
          await harness.runtime.startAgent("agent-a", config, undefined, "duplicate-wake", {
            wakeMessage: message,
          });
          expect(activities).toHaveLength(2);
          expect(harness.notices).toHaveLength(1);
        }
      } finally {
        gate.resolve();
        await harness.runtime.stop();
      }
    },
  );

  test("late acceptance while stopping does not report Message received", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const activities: string[] = [];
    const harness = await queueHarness({
      activity: (activity) => activities.push(activity.detailKind),
      notify: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      const delivery = harness.delivery(1);
      await entered.promise;
      const stopping = harness.runtime.stopAgent("agent-a");
      gate.resolve();
      await delivery;
      await stopping;
      await harness.runtime.startAgent("agent-a", config);
      expect(activities).toEqual(["starting", "stopped", "starting"]);
      expect(harness.acknowledgements).toEqual(["delivery-1"]);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });

  test("Activity publication failure does not reject accepted delivery", async () => {
    const harness = await queueHarness({
      activity: (activity) => {
        if (activity.detailKind === "model_request_started") throw new Error("offline observer");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      await harness.delivery(1);
      await harness.delivery(1);
      expect(harness.acknowledgements).toEqual(["delivery-1", "delivery-1"]);
      expect(harness.notices).toHaveLength(1);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("does not ACK rejected notification and accepts redelivery in the same session", async () => {
    let attempts = 0;
    const activities: string[] = [];
    const harness = await queueHarness({
      activity: (activity) => activities.push(activity.detailKind),
      notify: () => {
        attempts++;
        if (attempts === 1) throw new Error("code agent request failed");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      await expect(harness.delivery(1)).rejects.toThrow("code agent request failed");
      expect(harness.acknowledgements).toEqual([]);
      expect(activities).toEqual(["starting"]);
      await harness.delivery(1);
      expect(attempts).toBe(2);
      expect(activities).toEqual(["starting", "model_request_started"]);
      expect(harness.acknowledgements).toEqual(["delivery-1"]);
      expect(harness.sessions()).toBe(1);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("shares a concurrent Agent launch and mints one credential", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: (credential: string) => void;
    const credential = new Promise<string>((resolve) => (release = resolve));
    let mints = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            mints++;
            return agentLaunchConfig(await credential);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    const first = runtime.startAgent("agent-a", config);
    const second = runtime.startAgent("agent-a", config);
    expect(second).toBe(first);
    expect(mints).toBe(1);
    release(`sk_agent_${"a".repeat(43)}`);
    await Promise.all([first, second]);
    await runtime.stop();
  });

  test("queues launch recovery before live delivery", async () => {
    let release!: (credential: string) => void;
    const credential = new Promise<string>((resolve) => (release = resolve));
    const harness = await queueHarness({ credential });
    const launch = harness.runtime.startAgent("agent-a", config);
    const launchRecovery = {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "hello from recovery",
        },
      ],
      unreadSummary: { "@ada": 1 },
    };
    const recoveryForLaunch = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "recovery",
      launchRecovery,
    );
    const live = harness.delivery(2);

    release(`sk_agent_${"a".repeat(43)}`);
    const [started, recovered] = await Promise.all([launch, recoveryForLaunch, live]);
    expect(recovered).toBe(started);
    expect(harness.notices[0]).toContain("New message received:");
    expect(harness.notices[0]).toContain("hello");
    expect(harness.notices[1]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-2"]);
    expect(harness.sessions()).toBe(1);
    await harness.runtime.stop();
  });

  test("ready waits for recovery added to an existing launch", async () => {
    let releaseLaunch!: () => void;
    let releaseRecovery!: () => void;
    const launchGate = new Promise<void>((resolve) => (releaseLaunch = resolve));
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const harness = await queueHarness({ launch: () => launchGate, notify: () => recoveryGate });

    const launching = harness.runtime.startAgent("agent-a", config);
    const recovering = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "recovery",
      recovery,
    );
    releaseLaunch();
    const started = await launching;

    expect(harness.runningAgentIds()).toEqual([]);
    releaseRecovery();
    const recovered = await recovering;
    expect(recovered).toBe(started);
    expect(harness.sessions()).toBe(1);
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    await harness.runtime.stop();
  });

  test("ready reports only Agents past recovery and outside stopping", async () => {
    let releaseRecovery!: () => void;
    let releaseDispose!: () => void;
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const harness = await queueHarness({ notify: () => recoveryGate, dispose: () => disposeGate });
    const launching = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "recover",
        },
      ],
      unreadSummary: { "@ada": 1 },
    });
    await Bun.sleep(0);
    expect(harness.runningAgentIds()).toEqual([]);
    releaseRecovery();
    await launching;
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);

    const stopping = harness.runtime.stopAgent("agent-a");
    expect(harness.runningAgentIds()).toEqual([]);
    releaseDispose();
    await stopping;
    await harness.runtime.stop();
  });

  test("failed launch recovery disposes the runtime and can retry canonical recovery", async () => {
    let notifyAttempts = 0;
    let disposals = 0;
    const received: string[] = [];
    const harness = await queueHarness({
      activity(activity) {
        if (activity.detailKind === "model_request_started") received.push(activity.detail);
      },
      notify() {
        notifyAttempts++;
        if (notifyAttempts === 1) throw new Error("recovery rejected");
      },
      dispose() {
        disposals++;
      },
    });
    const recoveryContext = {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "retry this recovery body",
        },
      ],
      unreadSummary: { "@ada": 1 },
    };

    await expect(
      harness.runtime.startAgent("agent-a", config, undefined, "failed-recovery", recoveryContext),
    ).rejects.toThrow("recovery rejected");
    expect(harness.runningAgentIds()).toEqual([]);
    expect(disposals).toBe(1);
    expect(received).toEqual([]);

    await harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "retried-recovery",
      recoveryContext,
    );
    expect(harness.sessions()).toBe(2);
    expect(harness.notices).toHaveLength(2);
    expect(harness.notices.every((notice) => notice.includes("retry this recovery body"))).toBe(
      true,
    );
    expect(received).toEqual(["Message received"]);
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    await harness.runtime.stop();
  });

  test("failed launch recovery preserves an explicit stop fence until stop completes", async () => {
    let rejectRecovery!: (error: Error) => void;
    let markRecoveryStarted!: () => void;
    let markDisposed!: () => void;
    const recoveryGate = new Promise<void>((_, reject) => (rejectRecovery = reject));
    const recoveryStarted = new Promise<void>((resolve) => (markRecoveryStarted = resolve));
    const disposed = new Promise<void>((resolve) => (markDisposed = resolve));
    const harness = await queueHarness({
      async notify() {
        markRecoveryStarted();
        await recoveryGate;
      },
      dispose() {
        markDisposed();
      },
    });
    const launching = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "blocked-recovery",
      recovery,
    );
    await recoveryStarted;

    const startDuringStop = launching.then(
      () => "launch unexpectedly succeeded",
      async () => {
        try {
          await harness.runtime.startAgent("agent-a", config);
          return "start unexpectedly succeeded";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    const stopping = harness.runtime.stopAgent("agent-a");
    rejectRecovery(new Error("recovery rejected"));
    await expect(launching).rejects.toThrow("recovery rejected");
    await disposed;

    expect(await startDuringStop).toContain("stopping");
    await stopping;
    await harness.runtime.startAgent("agent-a", config);
    await harness.runtime.stop();
  });

  test("active recovery rebind keeps its runtime and precedes live delivery", async () => {
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const harness = await queueHarness({
      notify: (notice) => (notice.includes("wake only") ? recoveryGate : undefined),
    });
    const active = await harness.runtime.startAgent("agent-a", config);
    const rebound = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
      wakeMessage: {
        messageId: "wake-message",
        deliveryId: "wake-delivery",
        conversationId: "conversation-a",
        sequence: 3,
        target: "@ada",
        latestSender: "@ada",
        body: "wake only",
      },
      resumeMessages: [
        {
          messageId: "resume-message",
          deliveryId: "resume-delivery",
          conversationId: "conversation-a",
          sequence: 2,
          target: "@ada",
          latestSender: "@ada",
          body: "must be ignored",
        },
      ],
      unreadSummary: { "@grace": 9 },
    });
    const live = harness.delivery(4);
    await Bun.sleep(0);

    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("wake only");
    expect(harness.notices[0]).not.toContain("must be ignored");
    expect(harness.notices[0]).not.toContain("@grace");
    expect(harness.acknowledgements).toEqual([]);
    releaseRecovery();
    expect(await rebound).toBe(active);
    await live;
    expect(harness.notices[1]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-4"]);
    expect(harness.sessions()).toBe(1);
    expect(harness.mints()).toBe(1);
    await harness.runtime.stop();
  });

  test("active rebind without a wake ignores resume context and continues live delivery", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent("agent-a", config);

    await Promise.all([
      harness.runtime.startAgent("agent-a", config, undefined, "recovery", recovery),
      harness.delivery(2),
    ]);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-2"]);
    await harness.runtime.stop();
  });

  test("stop lets current input finish without continuing queued items", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = await queueHarness({ notify: () => gate });
    await harness.runtime.startAgent("agent-a", config);
    const current = harness.delivery(1);
    const queued = harness.delivery(2);
    void queued.catch(() => {});
    await Bun.sleep(0);
    const stop = harness.runtime.stopAgent("agent-a");
    release();

    await Promise.all([current, stop]);
    await expect(queued).rejects.toThrow("stopping");
    expect(harness.notices).toHaveLength(1);
    expect(harness.acknowledgements).toEqual(["delivery-1"]);
    await harness.runtime.stop();
  });

  test("stopAgent during credential mint cancels that launch and permits a later launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: (credential: string) => void;
    const pendingCredential = new Promise<string>((resolve) => (release = resolve));
    const replacementCredential = `sk_agent_${"c".repeat(43)}`;
    let mintCount = 0;
    let childStarts = 0;
    const revoked: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          childStarts++;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            mintCount++;
            return agentLaunchConfig(
              mintCount === 1 ? await pendingCredential : replacementCredential,
            );
          },
          async revokeAgentApiKey(value) {
            revoked.push(value);
          },
        }),
      },
    );
    await runtime.start(connection);
    const launching = runtime.startAgent("agent-a", config);
    const stopping = runtime.stopAgent("agent-a");
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
    const cancelledCredential = `sk_agent_${"b".repeat(43)}`;
    release(cancelledCredential);
    await expect(launching).rejects.toThrow("stopping");
    await stopping;
    expect(childStarts).toBe(0);
    expect(revoked).toEqual([cancelledCredential]);

    await runtime.startAgent("agent-a", config);
    expect(childStarts).toBe(1);
    await runtime.stop();
  });

  test("an old process exit cannot revoke a replacement launch's local proxy token", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let releaseOldDispose!: () => void;
    const oldDispose = new Promise<void>((resolve) => (releaseOldDispose = resolve));
    const exitCallbacks: Array<Array<() => void>> = [];
    const proxyTokens: string[] = [];
    let launchCount = 0;
    const proxyFacade: AgentProxy = {
      url: "",
      issue: () => {
        throw new Error("proxy is not initialized");
      },
      revoke: () => undefined,
      close: () => undefined,
    };
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(input) {
          launchCount++;
          proxyTokens.push(input.environment?.COFORGE_AGENT_CONTEXT ?? "");
          const currentLaunch = launchCount;
          const launchExitCallbacks: Array<() => void> = [];
          exitCallbacks.push(launchExitCallbacks);
          return {
            ...sessionSpy(),
            onExit(callback) {
              launchExitCallbacks.push(callback);
              return () => undefined;
            },
            async dispose() {
              if (currentLaunch === 1) await oldDispose;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async agentMessage() {
            return {
              protocolMajor: 1,
              requestId: "replacement",
              accepted: true,
              attentionCount: 0,
              messages: [],
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(
              `sk_agent_${String.fromCharCode(96 + launchCount + 1).repeat(43)}`,
            );
          },
          async revokeAgentApiKey() {
            throw new Error("remote revoke failed");
          },
        }),
      },
      proxyFacade,
    );
    const proxy = startAgentProxy({ runtime });
    proxyFacade.url = proxy.url;
    proxyFacade.issue = proxy.issue;
    proxyFacade.revoke = proxy.revoke;
    proxyFacade.close = proxy.close;

    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const stopping = runtime.stopAgent("agent-a");
      await Promise.resolve();
      await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
      releaseOldDispose();
      await expect(stopping).rejects.toThrow("remote revoke failed");

      await runtime.startAgent("agent-a", config);
      const replacementToken = proxyTokens[1]!;
      const request = () =>
        fetch(proxy.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${replacementToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requestId: "replacement", operation: "check" }),
        });
      expect((await request()).status).toBe(200);
      for (const callback of exitCallbacks[0] ?? []) callback();
      expect((await request()).status).toBe(200);
    } finally {
      proxy.close();
    }
  });

  test("publishes current-launch command and tool Activity details", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    const sessions: Array<{
      event(event: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]): void;
      delayedExit(): void;
    }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
          const exits: Array<() => void> = [];
          let exited = false;
          const control = {
            event: (event: Parameters<typeof listener>[0]) => listener(event),
            delayedExit: () => {
              for (const exit of exits) exit();
            },
          };
          sessions.push(control);
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
            onExit(callback) {
              exits.push(callback);
              return () => undefined;
            },
            async dispose() {
              if (!exited) {
                exited = true;
                for (const exit of exits) exit();
              }
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(
              `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
            );
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    const intent = {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await runtime.handleAgentStart(intent);
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail:
          "printf 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789",
        observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/input.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.100Z"),
        entries: [{ kind: "tool_start", toolName: "read_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/output.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.200Z"),
        entries: [{ kind: "tool_start", toolName: "write_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/existing.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.300Z"),
        entries: [{ kind: "tool_start", toolName: "edit_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "WebSearch query=CoForge",
        observedAtMs: Date.parse("2026-08-29T00:00:00.400Z"),
        entries: [{ kind: "tool_start", toolName: "WebSearch" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "runtime_error",
        level: "error",
        detail: "request timed out: Bearer fixture-private-token",
        observedAtMs: Date.parse("2026-08-29T00:00:00.500Z"),
      },
    });
    const firstLaunch = activities[0]!.launchId;
    expect(firstLaunch).not.toBe("");
    expect(activities.every((activity) => activity.launchId === firstLaunch)).toBe(true);
    expect(activities.map(({ clientSeq }) => clientSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(activities[1]!.detail).toBe(
      "printf 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012",
    );
    expect(activities.slice(2, 6).map(({ detail }) => detail)).toEqual([
      "/workspace/src/input.ts",
      "/workspace/src/output.ts",
      "/workspace/src/existing.ts",
      "WebSearch query=CoForge",
    ]);
    expect(activities[6]!.detail).toBe("request timed out: Bearer fixture-private-token");

    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "runtime_reconnecting",
        level: "info",
        detail: "Codex reconnecting to provider…",
        observedAtMs: Date.now(),
        entries: [{ kind: "text", text: "Reconnecting... 3/5" }],
      },
    });
    expect(activities[7]).toMatchObject({
      detailKind: "runtime_reconnecting",
      level: "info",
      detail: "Codex reconnecting to provider…",
      entries: [{ kind: "text", text: "Reconnecting... 3/5" }],
    });

    const stopping = runtime.stopAgent("agent-a");
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail: "late command",
        observedAtMs: Date.parse("2026-08-29T00:00:01.000Z"),
      },
    });
    await stopping;
    expect(activities.map(({ detailKind }) => detailKind)).toEqual([
      "starting",
      "running_command",
      "tool_started",
      "tool_started",
      "tool_started",
      "tool_started",
      "runtime_error",
      "runtime_reconnecting",
      "stopped",
    ]);

    await runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    const beforeOldCallbacks = activities.length;
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail: "stale command",
        observedAtMs: Date.parse("2026-08-29T00:00:02.000Z"),
      },
    });
    sessions[0]!.delayedExit();
    expect(activities).toHaveLength(beforeOldCallbacks);
    expect(activities.at(-1)!.launchId).not.toBe(firstLaunch);
    expect(activities.at(-1)!.clientSeq).toBe(1);
    await runtime.stop();
  });

  test("reports a fenced fresh session and an honest notice without exposing unrelated provider errors", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    let fail = false;
    const reports: import("@coforge/protocol").AgentSessionReport[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          if (fail) throw new Error("private-provider-token");
          await options.onSessionId?.("new-session", "old-session");
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          async reportAgentSession(report) {
            reports.push(report);
          },
        }),
      },
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config, "old-session", "cloud-start");
      expect(reports[0]).toMatchObject({
        sessionId: "new-session",
        replacedSessionId: "old-session",
        startRequestId: "cloud-start",
      });
      expect(
        activities.some(
          (activity) =>
            activity.detail ===
            "Original session history was not found. A new session was started; previous context was not restored.",
        ),
      ).toBe(true);
      fail = true;
      await expect(runtime.startAgent("agent-b", config)).rejects.toThrow("private-provider-token");
      expect(activities.at(-1)?.detail).toBe("Agent runtime could not be started.");
      expect(JSON.stringify(activities)).not.toContain("private-provider-token");
    } finally {
      await runtime.stop();
    }
  });

  test("reports a safe launch failure and blocks retry when startup cleanup is unresolved", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const lifecycle: string[] = [];
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    let credentialRequests = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          throw new AgentProcessCleanupError();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentStatus(status) {
            lifecycle.push(`status:${status.status}`);
          },
          sendAgentActivity(activity) {
            activities.push(activity);
            lifecycle.push(`activity:${activity.detailKind}`);
          },
          async requestAgentLaunchConfig() {
            credentialRequests++;
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);

    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow(
      "process tree did not exit",
    );
    expect(lifecycle).toEqual(["status:inactive", "activity:runtime_error"]);
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["runtime_error"]);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      detailKind: "runtime_error",
      level: "error",
      clientSeq: 1,
      detail: "Agent process cleanup could not be confirmed. Replacement launch is blocked.",
    });
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
    expect(credentialRequests).toBe(1);
    await runtime.stop().catch(() => undefined);
  });

  test("reports stop failure when process-tree exit cannot be confirmed", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            async dispose() {
              throw new AgentProcessCleanupError();
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"b".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "start-stop-failure",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi",
      model: "default",
      reasoning: "balanced",
    });

    await expect(runtime.stopAgent("agent-a")).rejects.toThrow("process tree did not exit");
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "runtime_error"]);
    expect(activities[1]).toMatchObject({
      level: "error",
      clientSeq: 2,
      detail: "Agent process cleanup could not be confirmed. Replacement launch is blocked.",
    });
    await runtime.stop().catch(() => undefined);
  });

  test("does not publish an old session exit after daemon stop and restart", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    const oldExitListeners: Array<() => void> = [];
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          launches++;
          const listeners = launches === 1 ? oldExitListeners : [];
          return {
            ...sessionSpy(),
            onExit(listener) {
              listeners.push(listener);
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${String.fromCharCode(97 + launches).repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    const intent = {
      protocolMajor: 1,
      requestId: "old-launch",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    await runtime.stop();
    await runtime.start(connection);
    await runtime.handleAgentStart({ ...intent, requestId: "new-launch" });
    const beforeDelayedExit = activities.length;

    for (const listener of oldExitListeners) listener();

    expect(activities).toHaveLength(beforeDelayedExit);
    expect(activities.at(-1)?.requestId).toBe("new-launch");
    await runtime.stop();
  });

  test("failed remote revoke keeps its handle for shutdown retry and closes local access first", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let attempts = 0;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    const proxyRevokes: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {
            await stopGate;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"c".repeat(43)}`);
          },
          async revokeAgentApiKey() {
            attempts++;
            if (attempts === 1) throw new Error("offline");
          },
        }),
      },
      { url: "http://proxy", issue: () => "proxy-token", revoke: (id) => proxyRevokes.push(id) },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const stopping = runtime.stop();
    expect(proxyRevokes).toEqual(["proxy-token"]);
    await expect(runtime.startAgent("agent-b", config)).rejects.toThrow("not running");
    await expect(
      runtime.agentMessage("proxy-token", {
        requestId: "r",
        operation: "check",
        context: "proxy-token",
      }),
    ).rejects.toThrow("not running");
    releaseStop();
    await expect(stopping).rejects.toThrow("offline");
    await runtime.stop();
    expect(attempts).toBe(2);
  });

  test("shutdown retry reuses the authenticated production transport for pending revokes", async () => {
    const configuredConnection = {
      ...connection,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "daemon-token");
    const credential = `sk_agent_${"d".repeat(43)}`;
    const revokeAuthorizations: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (init?.method === "POST") return Response.json({ apiKey: credential });
        revokeAuthorizations.push(new Headers(init?.headers).get("authorization"));
        return revokeAuthorizations.length === 1
          ? new Response(null, { status: 503 })
          : Response.json({ revoked: true });
      },
      { preconnect: originalFetch.preconnect },
    );
    let transportsCreated = 0;
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => {
          transportsCreated++;
          return new DaemonConnection("wss://cloud.example", () => connectedClient());
        },
      },
    );
    try {
      await runtime.start(configuredConnection);
      await runtime.startAgent("agent-a", config);
      await expect(runtime.stop()).rejects.toThrow("503");
      await runtime.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(revokeAuthorizations).toEqual(["Bearer daemon-token", "Bearer daemon-token"]);
    expect(transportsCreated).toBe(2);
  });

  test("keeps App notices separate from Message state and drains them on normalized idle", async () => {
    const stateDirectory = join(tmpdir(), `coforge-inbox-runtime-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notices: string[] = [];
    let listener: ((event: AgentRuntimeEvent) => void) | undefined;
    const exits = new Set<() => void>();
    let starts = 0;
    let cloudMessageCalls = 0;
    let deliveryAcks = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          starts++;
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              notices.push(notice);
            },
            subscribe(next) {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            onExit(next) {
              exits.add(next);
              return () => exits.delete(next);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {
            deliveryAcks++;
          },
          async agentMessage() {
            cloudMessageCalls++;
            throw new Error("must not read cloud");
          },
        }),
      },
      undefined,
      async () => ({ runtimes: [], catalogs: [] }),
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      const input = {
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000", revision: "1" },
        title: "Due",
        summary: "Now",
      };
      await runtime.mintAppItem("agent-a", input);
      expect(notices).toEqual([]);
      await runtime.startAgent("agent-a", config);
      await Bun.sleep(10);
      expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
      listener?.({
        type: "activity",
        activity: {
          detailKind: "idle",
          level: "info",
          detail: "idle",
          observedAtMs: Date.now(),
        },
      });
      await Bun.sleep(10);
      expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
      for (const exit of exits) exit();
      await runtime.mintAppItem("agent-a", {
        ...input,
        sourceRef: { ...input.sourceRef, revision: "2" },
      });
      expect(starts).toBe(2);
      expect(notices).toHaveLength(2);
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "delivery-request",
        messageId: "message-1",
        deliveryId: "delivery-1",
        sequence: 1,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "private chat body",
        method: "agent:deliver",
        target: "@ada",
      });
      await runtime.drainAppInboxNotices("agent-a");
      expect(notices).toHaveLength(3);
      const context = runtime.issueAgentContext("agent-a");
      const snapshot = await runtime.inbox(context, {
        requestId: "check",
        context,
        operation: "check",
      });
      expect(snapshot.entries.map((entry) => entry.kind).sort()).toEqual([
        "app",
        "app",
        "message_target",
      ]);
      const unchanged = await runtime.inbox(context, {
        requestId: "check-again",
        context,
        operation: "check",
      });
      expect(unchanged.entries.map((entry) => entry.kind).sort()).toEqual([
        "app",
        "app",
        "message_target",
      ]);
      expect(cloudMessageCalls).toBe(0);
      expect(deliveryAcks).toBe(1);
      await runtime.mintAppItem("agent-a", input);
      expect(notices).toHaveLength(3);
      expect(cloudMessageCalls).toBe(0);
      expect(deliveryAcks).toBe(1);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("a reminder-triggered restart waits for the shared notice outcome before becoming terminal", async () => {
    const stateDirectory = join(tmpdir(), `coforge-reminder-notice-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notify = Promise.withResolvers<void>();
    const notifyStarted = Promise.withResolvers<void>();
    const exits = new Set<() => void>();
    let sessions = 0;
    let receiveReminder!: (sync: import("@coforge/protocol").ReminderSync) => void;
    const reminderId = "123e4567-e89b-42d3-a456-426614174000";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          sessions++;
          return {
            ...sessionSpy(),
            ...(sessions === 2
              ? {
                  notify: async () => {
                    notifyStarted.resolve();
                    await notify.promise;
                  },
                }
              : {}),
            onExit(next) {
              exits.add(next);
              return () => exits.delete(next);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderSync(callback) {
            receiveReminder = callback;
            return () => undefined;
          },
          async fireReminder(request) {
            return { ...request, result: "accepted", fired: true, catchup: false } as const;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      async () => ({ runtimes: [], catalogs: [] }),
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      receiveReminder({
        protocolMajor: 1,
        requestId: "reminder-snapshot",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        operation: "snapshot",
        messageType: "coforge.rpc.v1.ReminderSync",
        jobs: [
          {
            reminderId,
            ownerAgentId: "agent-a",
            version: 1,
            title: "Retry me",
            target: "@frank",
            messageId: "123e4567-e89b-42d3-a456-426614174001",
            fireAt: new Date(Date.now() - 1_000).toISOString(),
          },
        ],
      });
      await notifyStarted.promise;
      const concurrentDrain = runtime.drainAppInboxNotices("agent-a");
      notify.reject(new Error("notify rejected"));
      await expect(concurrentDrain).rejects.toThrow("notify rejected");

      const receipts = (await Bun.file(
        join(
          stateDirectory,
          "reminder-receipts",
          connection.workspaceId,
          "agent-a",
          "receipts.json",
        ),
      ).json()) as { receipts: Array<{ wakeAccepted: boolean; terminal: boolean }> };
      expect(receipts.receipts[0]).toMatchObject({ wakeAccepted: false, terminal: false });
    } finally {
      notify.resolve();
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("projects a long multiline reminder title into the App Inbox without changing its occurrence", async () => {
    const stateDirectory = join(tmpdir(), `coforge-reminder-preview-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notified = Promise.withResolvers<void>();
    let receiveReminder!: (sync: import("@coforge/protocol").ReminderSync) => void;
    const fullTitle = `  检查\n\t${"中".repeat(115)}😀${"长期项目进度".repeat(30)}  `;
    const reminderId = "123e4567-e89b-42d3-a456-426614174000";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return { ...sessionSpy(), notify: async () => notified.resolve() };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderSync(callback) {
            receiveReminder = callback;
            return () => undefined;
          },
          async fireReminder(request) {
            return { ...request, result: "accepted", fired: true, catchup: false } as const;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      async () => ({ runtimes: [], catalogs: [] }),
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      receiveReminder({
        protocolMajor: 1,
        requestId: "reminder-snapshot",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        operation: "snapshot",
        messageType: "coforge.rpc.v1.ReminderSync",
        jobs: [
          {
            reminderId,
            ownerAgentId: "agent-a",
            version: 1,
            title: fullTitle,
            target: "@frank",
            messageId: "123e4567-e89b-42d3-a456-426614174001",
            fireAt: new Date(Date.now() - 1_000).toISOString(),
          },
        ],
      });
      await notified.promise;

      const context = runtime.issueAgentContext("agent-a");
      const inbox = await runtime.inbox(context, {
        requestId: "check-reminder",
        context,
        operation: "check",
      });
      const app = inbox.entries[0]?.kind === "app" ? inbox.entries[0].app : undefined;
      expect(app?.title).toHaveLength(120);
      expect(app?.title).not.toMatch(/[\r\n\t]/);
      expect(app?.title).toStartWith("检查 ");
      expect(app?.title).toEndWith("😀");

      const acknowledgement = await runtime.reminder(
        context,
        { requestId: "ack-reminder", context, operation: "ack", reminderId, revision: 1 },
        `sk_agent_${"a".repeat(43)}`,
      );
      expect(acknowledgement).toMatchObject({ accepted: true, reminderId, revision: 1 });
      expect(
        (await runtime.inbox(context, { requestId: "after-ack", context, operation: "check" }))
          .entries,
      ).toEqual([]);
      const receipts = (await Bun.file(
        join(
          stateDirectory,
          "reminder-receipts",
          connection.workspaceId,
          "agent-a",
          "receipts.json",
        ),
      ).json()) as { receipts: Array<{ job: { title: string } }> };
      expect(receipts.receipts[0]?.job.title).toBe(fullTitle);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});

function connectedClient(): CentrifugeWorkspaceClient {
  let connected: (() => void) | undefined;
  return {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect() {
      connected?.();
    },
    disconnect() {},
    async rpc() {},
  };
}
