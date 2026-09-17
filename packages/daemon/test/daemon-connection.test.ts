import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  createAgentMessageHttpClient,
  defaultAgentChannelHttpClient,
  DaemonConnection,
  type AgentMessageTransportResponse,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";
import type { AgentSendResponse } from "@lrm/coforge-sdk/agent";
import {
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_STATUS_METHOD,
  AGENT_SESSION_INVALIDATE_METHOD,
  decodeAgentActivity,
  decodeAgentSessionInvalidate,
  decodeAgentStatus,
  decodeAgentMessageDeliveryAck,
  decodeDaemonRuntimeReadyRequest,
  encodeAgentMessageDelivery,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  encodeAgentActivityProbe,
  encodeComputerRestartIntent,
  decodeComputerUpgradeResult,
  COMPUTER_UPGRADE_RESULT_METHOD,
  type AgentReminderOperationRequest,
} from "@lrm/coforge-sdk/internal";
import { DAEMON_RUNTIME_READY_METHOD } from "@lrm/coforge-sdk/internal";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { AgentMessageRequestError } from "../src/connection/agent-message-request-error";
import { AgentTransportError } from "../src/connection/agent-transport-error";

/** Runs `run()` with a logtape capture sink installed for `coforge.daemon.*`, then restores the
 * previous (unconfigured) logging state. Mirrors the pattern in daemon-runtime.test.ts. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; records: LogRecord[] }> {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: { capture: (record) => records.push(record) },
    loggers: [
      { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["capture"] },
    ],
  });
  try {
    const result = await run();
    return { result, records };
  } finally {
    await reset();
  }
}

function fakeClient() {
  let connected = () => {};
  let failed = (_error: unknown) => {};
  let disconnected = () => {};
  let publication = (_event: { channel: string; data: Uint8Array }) => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else if (event === "disconnected") disconnected = callback as () => void;
      else if (event === "error") failed = callback as (error: unknown) => void;
      else publication = callback as typeof publication;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc: async () => new Uint8Array(),
  };
  return {
    client,
    connect: () => connected(),
    disconnect: () => disconnected(),
    fail: (error: unknown) => failed(error),
    publish: (channel: string, data: Uint8Array) => publication({ channel, data }),
  };
}

test("sends delivery ACK through the RPC method, not a publication", async () => {
  const fake = fakeClient();
  const calls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push({ method, data });
    return new Uint8Array();
  };
  let published = false;
  fake.client.publish = async () => {
    published = true;
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  const ack = {
    protocolMajor: 1,
    requestId: "request-1",
    messageId: "message-1",
    deliveryId: "delivery-1",
    sequence: 1,
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    method: AGENT_MESSAGE_ACK_METHOD,
  } as const;
  await transport.sendAgentDeliveryAck(ack);
  expect(published).toBe(false);
  expect(calls.map(({ method }) => method)).toEqual([
    "daemon:connection_status",
    AGENT_MESSAGE_ACK_METHOD,
  ]);
  expect(decodeAgentMessageDeliveryAck(calls[1]!.data)).toMatchObject(ack);
});

test("sends the Daemon API key as Connect Proxy data instead of a JWT token", async () => {
  const fake = fakeClient();
  let connection: { token: string; data?: Uint8Array } | undefined;
  const transport = new DaemonConnection("wss://cloud.example", (_endpoint, token, data) => {
    connection = { token, data };
    return fake.client;
  });
  await transport.start("daemon-api-key", config);
  expect(connection?.token).toBe("");
  expect(JSON.parse(new TextDecoder().decode(connection?.data))).toEqual({
    daemonApiKey: "daemon-api-key",
  });
});

test("publishes Agent activity best effort on its restricted channel", async () => {
  const fake = fakeClient();
  const publications: Array<{ channel: string; data: Uint8Array }> = [];
  fake.client.publish = async (channel, data) => {
    publications.push({ channel, data });
    throw new Error("activity observer unavailable");
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  const activity = {
    protocolMajor: 1,
    requestId: "activity-1",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    detailKind: "tool_started",
    level: "info",
    detail: "Running a tool",
    observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
    launchId: "launch-1",
    clientSeq: 1,
  } as const;

  expect(transport.sendAgentActivity(activity)).toBeUndefined();
  await Promise.resolve();

  expect(publications).toHaveLength(1);
  expect(publications[0]?.channel).toBe(`agent:activity:${config.workspaceId}`);
  expect(decodeAgentActivity(publications[0]!.data)).toMatchObject(activity);
});

test("sends Agent status transitions through the status RPC", async () => {
  const fake = fakeClient();
  const calls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push({ method, data });
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  transport.sendAgentStatus({
    protocolMajor: 1,
    requestId: "status-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId: "agent-1",
    status: "active",
    daemonInstanceId: "daemon-1",
    clientSeq: 1,
    observedAtMs: 1_000,
  });
  await Promise.resolve();

  expect(calls.map(({ method }) => method)).toEqual([
    "daemon:connection_status",
    AGENT_STATUS_METHOD,
  ]);
  expect(decodeAgentStatus(calls[1]!.data)).toEqual({
    protocolMajor: 1,
    requestId: "status-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId: "agent-1",
    status: "active",
    daemonInstanceId: "daemon-1",
    clientSeq: 1,
    observedAtMs: 1_000,
  });
});

test("refreshes Computer online status while the connection remains active", async () => {
  const fake = fakeClient();
  const calls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push({ method, data });
    return new Uint8Array();
  };
  let refresh!: () => void;
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, undefined, {
    schedule: () => 1,
    cancel: () => {},
    scheduleRepeating: (callback) => {
      refresh = callback;
      return 2;
    },
    cancelRepeating: () => {},
  });

  await transport.start("secret", config);
  refresh();
  await Promise.resolve();

  expect(calls.filter(({ method }) => method === "daemon:connection_status")).toHaveLength(2);
  expect(JSON.parse(new TextDecoder().decode(calls[1]!.data))).toEqual({
    ...config,
    online: true,
  });
  await transport.stop();
});

test("serializes Agent status reports so inactive cannot be overtaken", async () => {
  const fake = fakeClient();
  const statuses: string[] = [];
  let releaseActive!: () => void;
  let receiveInactive!: () => void;
  const inactiveReceived = new Promise<void>((resolve) => (receiveInactive = resolve));
  fake.client.rpc = async (method, data) => {
    if (method !== AGENT_STATUS_METHOD) return new Uint8Array();
    const status = decodeAgentStatus(data).status;
    statuses.push(status);
    if (status === "active") await new Promise<void>((resolve) => (releaseActive = resolve));
    else receiveInactive();
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  const report = (status: "active" | "inactive") =>
    transport.sendAgentStatus({
      protocolMajor: 1,
      requestId: `status-${status}`,
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      agentId: "agent-1",
      status,
      daemonInstanceId: "daemon-1",
      clientSeq: status === "active" ? 1 : 2,
      observedAtMs: status === "active" ? 1_000 : 2_000,
    });

  report("active");
  report("inactive");
  await Promise.resolve();
  expect(statuses).toEqual(["active"]);
  releaseActive();
  await inactiveReceived;
  expect(statuses).toEqual(["active", "inactive"]);
  await transport.stop();
});

test("retains Agent activity in memory while disconnected", () => {
  const fake = fakeClient();
  let publications = 0;
  fake.client.publish = async () => {
    publications++;
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);

  expect(
    transport.sendAgentActivity({
      protocolMajor: 1,
      requestId: "activity-1",
      workspaceId: config.workspaceId,
      agentId: "agent-1",
      detailKind: "starting",
      level: "info",
      detail: "Starting",
      observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
      launchId: "launch-1",
      clientSeq: 1,
    }),
  ).toBeUndefined();
  expect(publications).toBe(0);
});

test("retains only each Agent's newest activity while disconnected and flushes on reconnect", async () => {
  const fake = fakeClient();
  const publications: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
  fake.client.publish = async (_channel, data) => {
    publications.push(decodeAgentActivity(data));
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  fake.disconnect();
  const send = (agentId: string, launchId: string, clientSeq: number) =>
    transport.sendAgentActivity({
      protocolMajor: 1,
      requestId: `${agentId}-${clientSeq}`,
      workspaceId: config.workspaceId,
      agentId,
      detailKind: "tool_started",
      level: "info",
      detail: "latest",
      observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
      launchId,
      clientSeq,
    });
  send("agent-1", "old-launch", 1);
  send("agent-1", "new-launch", 1);
  send("agent-1", "new-launch", 2);
  send("agent-1", "old-launch", 99);
  send("agent-2", "launch-2", 1);
  fake.connect();
  await Promise.resolve();
  expect(
    publications.map(({ agentId, launchId, clientSeq }) => ({ agentId, launchId, clientSeq })),
  ).toEqual([
    { agentId: "agent-1", launchId: "new-launch", clientSeq: 2 },
    { agentId: "agent-2", launchId: "launch-2", clientSeq: 1 },
  ]);
});

function sessionInvalidate(
  agentId: string,
  launchId: string,
): import("@lrm/coforge-sdk/internal").AgentSessionInvalidate {
  return {
    protocolMajor: 1,
    requestId: `${agentId}-invalidate`,
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId,
    provider: "codex",
    sessionId: "stale-native-session",
    daemonInstanceId: "daemon-1",
    launchId,
    reason: "missing",
  };
}

/** Minimal `AgentSessionReport` the connection's `reportAgentSession` accepts, used only to
 * drive `#observeLaunchIdentity`'s bookkeeping in these tests. */
function sessionReport(
  agentId: string,
  launchId: string,
): import("@lrm/coforge-sdk/internal").AgentSessionReport {
  return {
    protocolMajor: 1,
    requestId: `${agentId}-report`,
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId,
    provider: "codex",
    sessionId: "current-native-session",
    startRequestId: "start-1",
    daemonInstanceId: "daemon-1",
    launchId,
  };
}

test("sends the session invalidate RPC (not a publication) when connected", async () => {
  const fake = fakeClient();
  const calls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push({ method, data });
    return new Uint8Array();
  };
  let published = false;
  fake.client.publish = async () => {
    published = true;
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  const message = sessionInvalidate("agent-1", "launch-1");

  expect(transport.sendSessionInvalidate(message)).toBeUndefined();
  await Promise.resolve();

  expect(published).toBe(false);
  expect(calls.map(({ method }) => method)).toEqual([
    "daemon:connection_status",
    AGENT_SESSION_INVALIDATE_METHOD,
  ]);
  expect(decodeAgentSessionInvalidate(calls[1]!.data)).toEqual(message);
});

test("buffers the session invalidate while disconnected and flushes once on reconnect", async () => {
  const fake = fakeClient();
  const calls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push({ method, data });
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  fake.disconnect();
  const message = sessionInvalidate("agent-1", "launch-1");

  expect(transport.sendSessionInvalidate(message)).toBeUndefined();
  expect(calls.filter(({ method }) => method === AGENT_SESSION_INVALIDATE_METHOD)).toHaveLength(0);

  fake.connect();
  await Promise.resolve();

  const flushed = calls.filter(({ method }) => method === AGENT_SESSION_INVALIDATE_METHOD);
  expect(flushed).toHaveLength(1);
  expect(decodeAgentSessionInvalidate(flushed[0]!.data)).toEqual(message);

  // Flushing clears the buffer: reconnecting again sends nothing further for this agent.
  fake.disconnect();
  fake.connect();
  await Promise.resolve();
  expect(calls.filter(({ method }) => method === AGENT_SESSION_INVALIDATE_METHOD)).toHaveLength(1);
});

test("keeps a buffered session invalidate when only a newer launch's Activity is observed (Raft's rule, not Activity)", async () => {
  const fake = fakeClient();
  const rpcCalls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    rpcCalls.push({ method, data });
    return new Uint8Array();
  };
  fake.client.publish = async () => {};
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  fake.disconnect();

  transport.sendSessionInvalidate(sessionInvalidate("agent-1", "old-launch"));
  // A late Activity for a DIFFERENT launch must never drop the pending invalidate: Raft learns
  // "a newer launch was observed" only from status/session-report sends, never from Activity.
  transport.sendAgentActivity({
    protocolMajor: 1,
    requestId: "agent-1-2",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    detailKind: "starting",
    level: "info",
    detail: "Starting",
    observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
    launchId: "new-launch",
    clientSeq: 1,
  });

  fake.connect();
  await Promise.resolve();

  const flushed = rpcCalls.filter(({ method }) => method === AGENT_SESSION_INVALIDATE_METHOD);
  expect(flushed).toHaveLength(1);
  expect(decodeAgentSessionInvalidate(flushed[0]!.data)).toEqual(
    sessionInvalidate("agent-1", "old-launch"),
  );
});

test("drops a pending session invalidate once a newer launch is observed via the session report", async () => {
  const fake = fakeClient();
  const rpcCalls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    rpcCalls.push({ method, data });
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  fake.disconnect();

  transport.sendSessionInvalidate(sessionInvalidate("agent-1", "old-launch"));
  // The session report is observed even though it cannot reach a disconnected server: the
  // observation is the daemon's own outbound intent, not proof of delivery.
  await transport.reportAgentSession(sessionReport("agent-1", "new-launch")).catch(() => {});

  fake.connect();
  await Promise.resolve();

  expect(rpcCalls.filter(({ method }) => method === AGENT_SESSION_INVALIDATE_METHOD)).toHaveLength(
    0,
  );
});

test("refuses to queue a new session invalidate for a launch older than the one last observed", async () => {
  const fake = fakeClient();
  const rpcCalls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    rpcCalls.push({ method, data });
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  await transport.reportAgentSession(sessionReport("agent-1", "new-launch"));
  fake.disconnect();

  transport.sendSessionInvalidate(sessionInvalidate("agent-1", "old-launch"));

  fake.connect();
  await Promise.resolve();

  expect(rpcCalls.filter(({ method }) => method === AGENT_SESSION_INVALIDATE_METHOD)).toHaveLength(
    0,
  );
});

test("still queues a session invalidate that matches the last observed launch", async () => {
  const fake = fakeClient();
  const rpcCalls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    rpcCalls.push({ method, data });
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  await transport.reportAgentSession(sessionReport("agent-1", "current-launch"));
  fake.disconnect();

  transport.sendSessionInvalidate(sessionInvalidate("agent-1", "current-launch"));

  fake.connect();
  await Promise.resolve();

  const flushed = rpcCalls.filter(({ method }) => method === AGENT_SESSION_INVALIDATE_METHOD);
  expect(flushed).toHaveLength(1);
  expect(decodeAgentSessionInvalidate(flushed[0]!.data)).toEqual(
    sessionInvalidate("agent-1", "current-launch"),
  );
});

test("logs a rejected session invalidate (e.g. an old server's unknown RPC) without throwing", async () => {
  const fake = fakeClient();
  fake.client.rpc = async () => {
    throw Object.assign(new Error("unknown RPC method"), { code: 404 });
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);

  const { records } = await captureLogs(async () => {
    expect(
      transport.sendSessionInvalidate(sessionInvalidate("agent-1", "launch-1")),
    ).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
  });

  const rejections = records.filter(
    (record) => record.properties.event === "agent_session:invalidate_rejected",
  );
  expect(rejections).toHaveLength(1);
  expect(rejections[0]!.properties).toMatchObject({
    request_id: "agent-1-invalidate",
    launch_id: "launch-1",
    reason: "missing",
    error_code: "404",
    outcome: "failed",
  });
});

test("logs an old server's unknown-method rejection at most once per connection lifetime", async () => {
  const fake = fakeClient();
  fake.client.rpc = async () => {
    throw Object.assign(new Error("unknown RPC method"), { code: 404 });
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);

  const { records } = await captureLogs(async () => {
    transport.sendSessionInvalidate(sessionInvalidate("agent-1", "launch-1"));
    await Promise.resolve();
    await Promise.resolve();
    transport.sendSessionInvalidate(sessionInvalidate("agent-1", "launch-2"));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    records.filter((record) => record.properties.event === "agent_session:invalidate_rejected"),
  ).toHaveLength(1);
});

const config = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
};

test("Agent reminder HTTP responses must correlate through the injected HTTP client", async () => {
  const fake = fakeClient();
  const request: AgentReminderOperationRequest = {
    protocolMajor: 1,
    requestId: "request-reminder",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId: "agent-a",
    operation: "list",
  };
  const scopes = ["protocolMajor", "requestId", "workspaceId", "computerId", "agentId"] as const;
  for (const scope of scopes) {
    const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
      async requestReminder({ request: input }) {
        return {
          ...input,
          [scope]: scope === "protocolMajor" ? 2 : "wrong-scope",
          accepted: true,
          reminders: [],
          events: [],
        };
      },
    });
    await transport.start("daemon-token", { ...config, serverHttpUrl: "https://server.example" });
    await expect(transport.agentReminder(request, `sk_agent_${"a".repeat(43)}`)).rejects.toThrow(
      "uncorrelated Agent reminder response",
    );
    await transport.stop();
  }
});

test("Agent reminder HTTP transport rejects network and malformed responses without global mocks", async () => {
  const request: AgentReminderOperationRequest = {
    protocolMajor: 1,
    requestId: "request-reminder",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId: "agent-a",
    operation: "list",
  };
  for (const fetcher of [
    async () => {
      throw new Error("secret-token network detail");
    },
    async () => new Response("not json", { status: 200 }),
    async () => Response.json({ result: { b64data: "not protobuf" } }),
  ]) {
    const client = createAgentMessageHttpClient(fetcher);
    await expect(
      client.requestReminder!({
        url: "https://server.example/api/agent/v1/reminders",
        agentApiKey: `sk_agent_${"a".repeat(43)}`,
        daemonApiKey: "daemon-token",
        request,
      }),
    ).rejects.toThrow(/Agent reminder (request failed|response is malformed)/);
  }
});

test("GitHub credential HTTP transport authenticates the Agent request", async () => {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const client = createAgentMessageHttpClient(async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({
      username: "x-access-token",
      password: "short-lived-token",
      expiresAt: "2026-09-16T21:00:00Z",
    });
  });
  const result = await client.requestGitHubCredential!({
    url: "https://server.example/api/agent/v1/github-credentials",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {},
  });

  expect(result.password).toBe("short-lived-token");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://server.example/api/agent/v1/github-credentials");
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer daemon-token");
  expect(calls[0]?.headers.get("x-coforge-agent-api-key")).toBe(
    `Bearer sk_agent_${"a".repeat(43)}`,
  );
  expect(calls[0]?.body).toEqual({});
});

test("GitHub credential HTTP transport rejects malformed credentials", async () => {
  const client = createAgentMessageHttpClient(async () =>
    Response.json({
      username: "github-app[bot]",
      password: "installation-token",
      expiresAt: "2026-09-16T21:00:00Z",
    }),
  );

  await expect(
    client.requestGitHubCredential!({
      url: "https://server.example/api/agent/v1/github-credentials",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {},
    }),
  ).rejects.toThrow("invalid GitHub credential response");
});

test("waits for connected and does not send a business payload", async () => {
  const fake = fakeClient();
  let connected = false;
  fake.client.connect = () =>
    setTimeout(() => {
      connected = true;
      fake.connect();
    }, 0);
  const transport = new DaemonConnection(
    "wss://cloud.example/connection/websocket",
    () => fake.client,
  );
  const start = transport.start("secret", config);
  expect(connected).toBe(false);
  await start;
  expect(connected).toBe(true);
});

test("rejects connection failures", async () => {
  const fake = fakeClient();
  fake.client.connect = () => undefined;
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const start = transport.start("secret", config);
  fake.fail(new Error("connection failed"));
  await expect(start).rejects.toThrow("connection failed");
});

test("stop is idempotent and a stopped transport can restart", async () => {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const transport = new DaemonConnection("wss://cloud.example", () => {
    const fake = fakeClient();
    clients.push(fake);
    return fake.client;
  });
  await transport.start("secret", config);
  await transport.stop();
  await transport.stop();
  await transport.start("secret", config);
  expect(clients).toHaveLength(2);
});

test("resends the last successful ready request after reconnect", async () => {
  const fake = fakeClient();
  const readyCalls: Uint8Array[] = [];
  fake.client.rpc = async (method, data) => {
    if (method === DAEMON_RUNTIME_READY_METHOD) readyCalls.push(data);
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  let reconnect!: () => void;
  const reconnected = new Promise<void>((resolve) => (reconnect = resolve));
  transport.onReconnect(reconnect);
  await transport.start("secret", config);
  expect(readyCalls).toHaveLength(0);
  let runningAgentIds = ["agent-1"];
  let requestSequence = 0;
  await transport.ready(() => ({
    protocolMajor: 1,
    requestId: `ready-${++requestSequence}`,
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds,
  }));

  runningAgentIds = ["agent-2"];
  fake.connect();
  await reconnected;

  expect(readyCalls).toHaveLength(2);
  expect(decodeDaemonRuntimeReadyRequest(readyCalls[0]!)).toMatchObject({
    requestId: "ready-1",
    runningAgentIds: ["agent-1"],
  });
  expect(decodeDaemonRuntimeReadyRequest(readyCalls[1]!)).toMatchObject({
    requestId: "ready-2",
    runningAgentIds: ["agent-2"],
  });
});

test("buffers reconnect publications until ready settles and preserves control arrival order", async () => {
  const fake = fakeClient();
  let settleReady!: () => void;
  let readyCalls = 0;
  fake.client.rpc = async (method) => {
    if (method === DAEMON_RUNTIME_READY_METHOD && ++readyCalls === 2)
      await new Promise<void>((resolve) => (settleReady = resolve));
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const dispatched: string[] = [];
  transport.onAgentStart(() => dispatched.push("start"));
  transport.onAgentStop(() => dispatched.push("stop"));
  transport.onAgentMessage(() => dispatched.push("delivery"));
  await transport.start("secret", config);
  await transport.ready(() => ({
    protocolMajor: 1,
    requestId: "ready-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds: [],
  }));

  fake.connect();
  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentStopIntent({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      agentId: "agent-1",
    }),
  );
  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentStartIntent({
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      agentId: "agent-1",
      provider: "pi",
      model: "default",
      reasoning: "balanced",
    }),
  );
  expect(dispatched).toEqual([]);

  settleReady();
  await Bun.sleep(0);
  expect(dispatched).toEqual(["stop", "start"]);
});

test("retries reconnect ready on the same connection before releasing buffered publications", async () => {
  const fake = fakeClient();
  let rejectReady!: (error: Error) => void;
  let readyCalls = 0;
  const readyPayloads: Uint8Array[] = [];
  let retryReady!: () => void;
  fake.client.rpc = async (method, data) => {
    if (method === DAEMON_RUNTIME_READY_METHOD) {
      readyPayloads.push(data);
      if (++readyCalls === 2) await new Promise<void>((_resolve, reject) => (rejectReady = reject));
    }
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, undefined, {
    schedule: (callback) => {
      retryReady = callback;
      return 1;
    },
    cancel: () => {},
  });
  const dispatched: string[] = [];
  let reconnects = 0;
  transport.onAgentStart(() => dispatched.push("start"));
  transport.onAgentMessage(() => dispatched.push("delivery"));
  transport.onReconnect(() => reconnects++);
  await transport.start("secret", config);
  let runningAgentIds = ["agent-before-retry"];
  let requestSequence = 0;
  await transport.ready(() => ({
    protocolMajor: 1,
    requestId: `ready-${++requestSequence}`,
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds,
  }));

  fake.connect();
  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentMessageDelivery({
      protocolMajor: 1,
      requestId: "delivery-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: config.workspaceId,
      conversationId: "conversation-1",
      agentId: "agent-1",
      body: "hello",
      method: "agent:deliver",
      target: "@alice",
    }),
  );
  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentStartIntent({
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      agentId: "agent-1",
      provider: "pi",
      model: "default",
      reasoning: "balanced",
    }),
  );
  rejectReady(new Error("reconnect ready failed"));
  await Bun.sleep(0);
  expect(dispatched).toEqual([]);
  expect(reconnects).toBe(0);

  runningAgentIds = ["agent-during-retry"];
  retryReady();
  await Bun.sleep(0);

  expect(readyCalls).toBe(3);
  expect(decodeDaemonRuntimeReadyRequest(readyPayloads[2]!)).toMatchObject({
    requestId: "ready-3",
    runningAgentIds: ["agent-during-retry"],
  });
  expect(dispatched).toEqual(["delivery", "start"]);
  expect(reconnects).toBe(1);
});

test("stop cancels a pending reconnect ready retry", async () => {
  const fake = fakeClient();
  let readyCalls = 0;
  let retryReady!: () => void;
  let cancelled = false;
  fake.client.rpc = async (method) => {
    if (method === DAEMON_RUNTIME_READY_METHOD && ++readyCalls === 2)
      throw new Error("reconnect ready failed");
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, undefined, {
    schedule: (callback) => {
      retryReady = callback;
      return 1;
    },
    cancel: () => {
      cancelled = true;
    },
  });
  await transport.start("secret", config);
  await transport.ready(() => ({
    protocolMajor: 1,
    requestId: "ready-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds: [],
  }));

  fake.connect();
  await Bun.sleep(0);
  await transport.stop();
  retryReady();
  await Bun.sleep(0);

  expect(cancelled).toBe(true);
  expect(readyCalls).toBe(2);
});

test("receives only publications directed to its Computer", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const started: string[] = [];
  transport.onAgentStart((intent) => started.push(intent.agentId));
  await transport.start("secret", config);
  const data = encodeAgentStartIntent({
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId: "agent-1",
    provider: "pi",
    model: "",
    reasoning: "",
  });

  fake.publish(`daemon:other-workspace:${config.computerId}`, data);
  fake.publish(`daemon:${config.workspaceId}:${config.computerId}`, data);

  expect(started).toEqual(["agent-1"]);
});

test("routes an agent:activity_probe publication to the probe slot", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const probed: string[] = [];
  transport.onAgentActivityProbe((probe) => probed.push(probe.probeId));
  await transport.start("secret", config);

  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-1",
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      agentId: "agent-1",
      probeId: "probe-1",
    }),
  );

  expect(probed).toEqual(["probe-1"]);
});

test("rejects an agent:activity_probe publication for a foreign Workspace", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const probed: string[] = [];
  transport.onAgentActivityProbe((probe) => probed.push(probe.probeId));
  await transport.start("secret", config);

  fake.publish(
    `daemon:other-workspace:${config.computerId}`,
    encodeAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-2",
      workspaceId: "other-workspace",
      computerId: config.computerId,
      agentId: "agent-1",
      probeId: "probe-2",
    }),
  );

  expect(probed).toEqual([]);
});

test("consumes the Connect Proxy-bound control stream without a client subscription", async () => {
  const fake = fakeClient();
  let subscriptions = 0;
  const centrifugeClient = Object.assign(fake.client, {
    newSubscription() {
      subscriptions++;
      return {
        on() {},
        subscribe() {},
        unsubscribe() {},
      };
    },
  });
  const transport = new DaemonConnection("wss://cloud.example", () => centrifugeClient);
  const started: string[] = [];
  transport.onAgentStart((intent) => started.push(intent.agentId));

  await transport.start("secret", config);
  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentStartIntent({
      protocolMajor: 1,
      requestId: "start-bound-control-stream",
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      agentId: "agent-1",
      provider: "pi",
      model: "",
      reasoning: "",
    }),
  );

  expect(subscriptions).toBe(0);
  expect(started).toEqual(["agent-1"]);
});

test("dispatches each scoped remote restart request once", async () => {
  const fake = fakeClient();
  const requests: string[] = [];
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", {
    ...config,
    requestRestart: async (requestId) => {
      requests.push(requestId);
    },
  });
  const restart = encodeComputerRestartIntent({
    protocolMajor: 1,
    requestId: "restart-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
  });

  fake.publish(`daemon:other-workspace:${config.computerId}`, restart);
  fake.publish(`daemon:${config.workspaceId}:${config.computerId}`, restart);
  fake.publish(`daemon:${config.workspaceId}:${config.computerId}`, restart);
  await Promise.resolve();

  expect(requests).toEqual(["restart-1"]);
});

test("failed Coordinator restart acceptance allows stable-request redelivery without concurrent duplicates", async () => {
  const fake = fakeClient();
  const first = Promise.withResolvers<void>();
  const requests: string[] = [];
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", {
    ...config,
    requestRestart: (id) => {
      requests.push(id);
      return requests.length === 1 ? first.promise : Promise.resolve();
    },
  });
  const restart = encodeComputerRestartIntent({
    protocolMajor: 1,
    requestId: "retry-restart",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
  });
  const publish = () => fake.publish(`daemon:${config.workspaceId}:${config.computerId}`, restart);
  try {
    publish();
    publish();
    expect(requests).toEqual(["retry-restart"]);
    first.reject(new Error("local RPC acceptance failed"));
    await first.promise.catch(() => {});
    publish();
    publish();
    expect(requests).toEqual(["retry-restart", "retry-restart"]);
  } finally {
    first.resolve();
    await transport.stop();
  }
});

test("contains a reconnect ready failure and retries on the next reconnect", async () => {
  const fake = fakeClient();
  let readyCalls = 0;
  fake.client.rpc = async (method) => {
    if (method === DAEMON_RUNTIME_READY_METHOD) {
      readyCalls++;
      if (readyCalls === 2) throw new Error("reconnect ready failed");
    }
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  await transport.ready(() => ({
    protocolMajor: 1,
    requestId: "ready-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds: [],
  }));

  fake.connect();
  await Promise.resolve();
  fake.disconnect();
  fake.connect();
  await Promise.resolve();

  expect(readyCalls).toBe(3);
});

test("uses the configured HTTP seam for Agent messages and never falls back to WS", async () => {
  const fake = fakeClient();
  const requests: unknown[] = [];
  const response = {
    protocolMajor: 1 as const,
    requestId: "request-2",
    messages: [],
    hasOlder: false,
    hasNewer: false,
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    requestRead: async (input) => {
      requests.push(input);
      return response;
    },
  });
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-2",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "read",
    target: "@ada",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: `https://server.example${agentApiRoutes.cloud.messages.list.path}`,
    agentApiKey: "daemon-token",
    daemonApiKey: "daemon-token",
    request: { operation: "read", target: "@ada" },
  });

  const noEndpoint = new DaemonConnection("wss://cloud.example", () => fake.client);
  await noEndpoint.start("daemon-token", config);
  await expect(
    noEndpoint.agentMessage({
      protocolMajor: 1,
      requestId: "request-3",
      workspaceId: config.workspaceId,
      agentId: "agent-1",
      operation: "read",
      target: "@user",
    }),
  ).rejects.toThrow("HTTP endpoint is not configured");
});

test("Agent read HTTP GET request carries the request id and sequence window", async () => {
  let capturedUrl: URL | undefined;
  const client = createAgentMessageHttpClient(async (input) => {
    capturedUrl = input as URL;
    return Response.json({
      protocolMajor: 1,
      requestId: "request-read-1",
      messages: [],
      hasOlder: false,
      hasNewer: false,
    });
  });
  await client.requestRead!({
    url: "https://server.example/api/agent/v1/messages",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-read-1",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "read",
      target: "@ada",
      fromSequence: 5,
      throughSequence: 12,
      limit: 50,
    },
  });
  expect(capturedUrl?.searchParams.get("requestId")).toBe("request-read-1");
  expect(capturedUrl?.searchParams.get("fromSequence")).toBe("5");
  expect(capturedUrl?.searchParams.get("throughSequence")).toBe("12");
  expect(capturedUrl?.searchParams.get("target")).toBe("@ada");
  expect(capturedUrl?.searchParams.get("limit")).toBe("50");
});

test("Agent search HTTP GET request carries the request id", async () => {
  let capturedUrl: URL | undefined;
  const client = createAgentMessageHttpClient(async (input) => {
    capturedUrl = input as URL;
    return Response.json({
      protocolMajor: 1,
      requestId: "request-search-1",
      results: [],
    });
  });
  await client.requestSearch!({
    url: "https://server.example/api/agent/v1/messages",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-search-1",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "search",
      target: "",
      query: "hello",
    },
  });
  expect(capturedUrl?.searchParams.get("requestId")).toBe("request-search-1");
  expect(capturedUrl?.searchParams.get("query")).toBe("hello");
});

test("Agent resolve HTTP GET request carries the request id", async () => {
  let capturedUrl: URL | undefined;
  const client = createAgentMessageHttpClient(async (input) => {
    capturedUrl = input as URL;
    return Response.json({
      protocolMajor: 1,
      requestId: "request-resolve-1",
      message: {
        id: "message-1",
        sequence: 1,
        sender: "@ada",
        body: "hi",
        createdAt: "now",
        attachments: [],
        target: "@ada",
      },
    });
  });
  const result = await client.requestResolve!({
    url: "https://server.example/api/agent/v1/messages/abcd1234/resolve",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-resolve-1",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "resolve",
      target: "",
      messageId: "abcd1234",
    },
  });
  expect(capturedUrl?.pathname).toBe("/api/agent/v1/messages/abcd1234/resolve");
  expect(capturedUrl?.searchParams.get("requestId")).toBe("request-resolve-1");
  expect(result.message.id).toBe("message-1");
});

test("Agent events HTTP GET request carries the request id and limit", async () => {
  let capturedUrl: URL | undefined;
  const client = createAgentMessageHttpClient(async (input) => {
    capturedUrl = input as URL;
    return Response.json({
      protocolMajor: 1,
      requestId: "request-events-1",
      events: [],
      hasMore: true,
    });
  });
  const result = await client.requestEvents!({
    url: "https://server.example/api/agent/v1/events",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-events-1",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "check",
      target: "",
      limit: 25,
    },
  });
  expect(capturedUrl?.searchParams.get("requestId")).toBe("request-events-1");
  expect(capturedUrl?.searchParams.get("limit")).toBe("25");
  expect(result.hasMore).toBe(true);
});

test.each(["mute", "unmute"] as const)(
  "Agent channel %s HTTP POST request carries the request id",
  async (operation) => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | URL | Request | undefined;
    const client = createAgentMessageHttpClient(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Response.json({
        protocolMajor: 1,
        requestId: "request-mute-1",
        target: "#general",
        muted: operation === "mute",
      });
    });
    const path =
      operation === "mute"
        ? "https://server.example/api/agent/v1/channels/%23general/mute"
        : "https://server.example/api/agent/v1/channels/%23general/unmute";
    const result = await client.requestChannelMute!({
      url: path,
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-mute-1",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation,
        target: "#general",
        muted: operation === "mute",
      },
    });
    expect(capturedUrl).toBe(path);
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ requestId: "request-mute-1" });
    expect(result.muted).toBe(operation === "mute");
  },
);

test("Agent thread unfollow HTTP POST request carries the request id", async () => {
  let capturedInit: RequestInit | undefined;
  const client = createAgentMessageHttpClient(async (_url, init) => {
    capturedInit = init;
    return Response.json({
      protocolMajor: 1,
      requestId: "request-unfollow-1",
      target: "#general:12345678-0000-4000-8000-000000000001",
      followed: false,
    });
  });
  const result = await client.requestThreadUnfollow!({
    url: "https://server.example/api/agent/v1/threads/thread-1/unfollow",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-unfollow-1",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "thread-unfollow",
      target: "#general:12345678-0000-4000-8000-000000000001",
    },
  });
  expect(capturedInit?.method).toBe("POST");
  expect(JSON.parse(capturedInit?.body as string)).toEqual({ requestId: "request-unfollow-1" });
  expect(result.followed).toBe(false);
});

test("requestSend HTTP POST body carries freshnessContextMode when set and omits the key otherwise", async () => {
  const capturedBodies: Record<string, unknown>[] = [];
  const client = createAgentMessageHttpClient(async (_url, init) => {
    capturedBodies.push(JSON.parse(init?.body as string));
    return Response.json({
      protocolMajor: 1,
      requestId: "request-send-1",
      state: "sent",
      messageId: "message-1",
      context: [],
    });
  });
  const baseRequest = {
    protocolMajor: 1,
    requestId: "request-send-1",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "send" as const,
    target: "@ada",
    body: "hi",
  };
  await client.requestSend!({
    url: "https://server.example/api/agent/v1/messages",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: { ...baseRequest, freshnessContextMode: "withheld" },
  });
  await client.requestSend!({
    url: "https://server.example/api/agent/v1/messages",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: baseRequest,
  });
  expect(capturedBodies[0]).toMatchObject({ freshnessContextMode: "withheld" });
  expect(capturedBodies[1]).not.toHaveProperty("freshnessContextMode");
});

test.each(["react", "unreact"] as const)(
  "Agent %s HTTP request carries the emoji in its JSON body",
  async (operation) => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | URL | Request | undefined;
    const client = createAgentMessageHttpClient(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Response.json({
        protocolMajor: 1,
        requestId: "request-react-1",
        messageId: "abcd1234",
        emoji: "👍",
        active: operation === "react",
      });
    });
    const method = operation === "react" ? "POST" : "DELETE";
    const result = await client.requestReaction!({
      url: "https://server.example/api/agent/v1/messages/abcd1234/reactions",
      method,
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-react-1",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation,
        target: "",
        messageId: "abcd1234",
        emoji: "👍",
      },
    });
    expect(capturedUrl).toBe("https://server.example/api/agent/v1/messages/abcd1234/reactions");
    expect(capturedInit?.method).toBe(method);
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      requestId: "request-react-1",
      emoji: "👍",
    });
    expect(result.messageId).toBe("abcd1234");
  },
);

test("requestRead surfaces a safe validation failure as AgentMessageRequestError", async () => {
  const readClient = createAgentMessageHttpClient(
    async () => new Response("message anchor not found in this conversation", { status: 400 }),
  );
  await expect(
    readClient.requestRead!({
      url: "https://server.example/api/agent/v1/messages",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-read-2",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation: "read",
        target: "@ada",
      },
    }),
  ).rejects.toEqual(
    AgentMessageRequestError.fromRpc(400, "message anchor not found in this conversation"),
  );
});

test("requestEvents, requestChannelMute, and requestThreadUnfollow surface non-2xx bodies as AgentMessageRequestError", async () => {
  const eventsClient = createAgentMessageHttpClient(
    async () => new Response("database password leaked", { status: 500 }),
  );
  await expect(
    eventsClient.requestEvents!({
      url: "https://server.example/api/agent/v1/events",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-events-2",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation: "check",
        target: "",
      },
    }),
  ).rejects.toThrow("server agent request failed (500)");

  const muteClient = createAgentMessageHttpClient(
    async () => new Response("mute requires a channel target", { status: 400 }),
  );
  await expect(
    muteClient.requestChannelMute!({
      url: "https://server.example/api/agent/v1/channels/%40ada/mute",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-mute-2",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation: "mute",
        target: "@ada",
        muted: true,
      },
    }),
  ).rejects.toEqual(AgentMessageRequestError.fromRpc(400, "mute requires a channel target"));

  const unfollowClient = createAgentMessageHttpClient(
    async () => new Response("unfollow requires a channel thread target", { status: 400 }),
  );
  await expect(
    unfollowClient.requestThreadUnfollow!({
      url: "https://server.example/api/agent/v1/threads/%23general/unfollow",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-unfollow-2",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation: "thread-unfollow",
        target: "#general",
      },
    }),
  ).rejects.toEqual(
    AgentMessageRequestError.fromRpc(400, "unfollow requires a channel thread target"),
  );
});

test("resolve and reaction HTTP clients surface safe validation failures as AgentMessageRequestError", async () => {
  const resolveClient = createAgentMessageHttpClient(
    async () => new Response("message not found or not visible to this Agent", { status: 400 }),
  );
  await expect(
    resolveClient.requestResolve!({
      url: "https://server.example/api/agent/v1/messages/abcd1234/resolve",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-resolve-2",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation: "resolve",
        target: "",
        messageId: "abcd1234",
      },
    }),
  ).rejects.toEqual(
    AgentMessageRequestError.fromRpc(400, "message not found or not visible to this Agent"),
  );

  const reactionClient = createAgentMessageHttpClient(
    async () => new Response("database password leaked", { status: 500 }),
  );
  await expect(
    reactionClient.requestReaction!({
      url: "https://server.example/api/agent/v1/messages/abcd1234/reactions",
      method: "POST",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-react-2",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation: "react",
        target: "",
        messageId: "abcd1234",
        emoji: "👍",
      },
    }),
  ).rejects.toThrow("server agent request failed (500)");
});

test("dispatches resolve and reaction operations to their dedicated HTTP client methods", async () => {
  const fake = fakeClient();
  const resolveCalls: unknown[] = [];
  const reactionCalls: unknown[] = [];
  const resolveResponse = {
    protocolMajor: 1 as const,
    requestId: "request-resolve",
    message: {
      id: "message-1",
      sequence: 1,
      sender: "@ada",
      target: "@ada",
      body: "hi",
      createdAt: "2026-09-16T00:00:00.000Z",
      attachments: [],
    },
  };
  const reactionResponse = {
    protocolMajor: 1 as const,
    requestId: "request-react",
    messageId: "abcd1234",
    emoji: "👍",
    active: true,
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    requestResolve: async (input) => {
      resolveCalls.push(input);
      return resolveResponse;
    },
    requestReaction: async (input) => {
      reactionCalls.push(input);
      return reactionResponse;
    },
  });
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-resolve",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "resolve",
    target: "",
    messageId: "abcd1234",
  });
  expect(resolveCalls).toEqual([
    expect.objectContaining({
      url: `https://server.example${agentApiRoutes.cloud.messages.resolve.path("abcd1234")}`,
    }),
  ]);
  await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-react",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "react",
    target: "",
    messageId: "abcd1234",
    emoji: "👍",
  });
  await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-unreact",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "unreact",
    target: "",
    messageId: "abcd1234",
    emoji: "👍",
  });
  expect(reactionCalls).toEqual([
    expect.objectContaining({
      url: `https://server.example${agentApiRoutes.cloud.messages.reactions.path("abcd1234")}`,
      method: "POST",
    }),
    expect.objectContaining({
      url: `https://server.example${agentApiRoutes.cloud.messages.reactions.path("abcd1234")}`,
      method: "DELETE",
    }),
  ]);
});

test("dispatches check, mute, unmute, and thread-unfollow operations to their dedicated HTTP client methods", async () => {
  const fake = fakeClient();
  const eventsCalls: unknown[] = [];
  const muteCalls: unknown[] = [];
  const unfollowCalls: unknown[] = [];
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    requestEvents: async (input) => {
      eventsCalls.push(input);
      return {
        protocolMajor: 1,
        requestId: "request-check",
        events: [
          {
            id: "message-1",
            sequence: 1,
            sender: "@ada",
            target: "@ada",
            body: "hello",
            createdAt: "2026-09-16T00:00:00.000Z",
            attachments: [],
          },
        ],
        hasMore: true,
      };
    },
    requestChannelMute: async (input) => {
      muteCalls.push(input);
      return {
        protocolMajor: 1,
        requestId: "request-mute",
        target: "#general",
        muted: input.request.muted,
      };
    },
    requestThreadUnfollow: async (input) => {
      unfollowCalls.push(input);
      return {
        protocolMajor: 1,
        requestId: "request-unfollow",
        target: "#general:12345678-0000-4000-8000-000000000001",
        followed: false,
      };
    },
  });
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  const checked = await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-check",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "check",
    target: "",
    limit: 10,
  });
  expect(eventsCalls).toEqual([
    expect.objectContaining({
      url: `https://server.example${agentApiRoutes.cloud.events.path}`,
    }),
  ]);
  expect(checked.messages).toHaveLength(1);
  expect(checked.hasMore).toBe(true);
  expect(checked.attentionCount).toBe(1);

  await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-mute",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "mute",
    target: "#general",
  });
  await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-unmute",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "unmute",
    target: "#general",
  });
  expect(muteCalls).toEqual([
    expect.objectContaining({
      url: `https://server.example${agentApiRoutes.cloud.channels.mute.path("#general")}`,
      request: expect.objectContaining({ muted: true }),
    }),
    expect.objectContaining({
      url: `https://server.example${agentApiRoutes.cloud.channels.unmute.path("#general")}`,
      request: expect.objectContaining({ muted: false }),
    }),
  ]);

  const unfollowed = await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-unfollow",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "thread-unfollow",
    target: "#general:12345678-0000-4000-8000-000000000001",
  });
  expect(unfollowCalls).toEqual([
    expect.objectContaining({
      url: `https://server.example${agentApiRoutes.cloud.threads.unfollow.path("#general:12345678-0000-4000-8000-000000000001")}`,
    }),
  ]);
  expect(unfollowed.accepted).toBe(true);
  expect(unfollowed.messages).toEqual([]);
});

test("adapts the read route's AgentHistoryResponse into the transport shape", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    requestRead: async () => ({
      protocolMajor: 1,
      requestId: "request-read",
      messages: [
        {
          id: "message-1",
          sequence: 1,
          sender: "@ada",
          target: "@ada",
          body: "hi",
          createdAt: "2026-09-16T00:00:00.000Z",
          attachments: [],
        },
      ],
      hasOlder: true,
      hasNewer: false,
      olderCursor: "cursor-older",
      newerCursor: "cursor-newer",
    }),
  });
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  const result = await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-read",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "read",
    target: "@ada",
  });
  expect(result).toMatchObject({
    accepted: true,
    attentionCount: 0,
    hasOlder: true,
    hasNewer: false,
    olderCursor: "cursor-older",
    newerCursor: "cursor-newer",
  });
  expect(result.messages).toHaveLength(1);
});

test("adapts the dedicated search route's AgentSearchResponse (results -> messages) into the transport shape", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    requestSearch: async () => ({
      protocolMajor: 1,
      requestId: "request-search",
      results: [
        {
          id: "message-1",
          sequence: 1,
          sender: "@ada",
          target: "@ada",
          body: "hi",
          createdAt: "2026-09-16T00:00:00.000Z",
          attachments: [],
        },
      ],
    }),
  });
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  const result = await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-search",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "search",
    target: "",
    query: "hi",
  });
  expect(result.accepted).toBe(true);
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]?.id).toBe("message-1");
});

test("adapts the resolve route's AgentResolveResponse (message -> messages: [message]) into the transport shape", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    requestResolve: async () => ({
      protocolMajor: 1,
      requestId: "request-resolve",
      message: {
        id: "message-1",
        sequence: 1,
        sender: "@ada",
        target: "@ada",
        body: "hi",
        createdAt: "2026-09-16T00:00:00.000Z",
        attachments: [],
      },
    }),
  });
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  const result = await transport.agentMessage({
    protocolMajor: 1,
    requestId: "request-resolve",
    workspaceId: config.workspaceId,
    agentId: "agent-1",
    operation: "resolve",
    target: "",
    messageId: "message-1",
  });
  expect(result.accepted).toBe(true);
  expect(result.messages).toEqual([expect.objectContaining({ id: "message-1", body: "hi" })]);
});

const sendAdapterCases: Array<{
  label: string;
  response: AgentSendResponse;
  expected: Partial<AgentMessageTransportResponse>;
}> = [
  {
    label: "sent with no bypass maps to forward",
    response: {
      protocolMajor: 1,
      requestId: "request-send",
      state: "sent",
      messageId: "message-1",
      context: [],
    },
    expected: { accepted: true, sideEffectDecision: "forward", messageId: "message-1" },
  },
  {
    label: "sent with bypass maps to anyway_accepted",
    response: {
      protocolMajor: 1,
      requestId: "request-send",
      state: "sent",
      messageId: "message-1",
      bypass: true,
      context: [],
    },
    expected: { accepted: true, sideEffectDecision: "anyway_accepted", messageId: "message-1" },
  },
  {
    label: "held maps to hold and carries the held context as messages/attentionCount",
    response: {
      protocolMajor: 1,
      requestId: "request-send",
      state: "held",
      holdToken: "hold-token-1",
      anywayAllowed: true,
      context: [
        {
          id: "message-1",
          sequence: 1,
          sender: "@ada",
          target: "@ada",
          body: "hi",
          createdAt: "2026-09-16T00:00:00.000Z",
          attachments: [],
        },
      ],
    },
    expected: {
      accepted: false,
      sideEffectDecision: "hold",
      holdToken: "hold-token-1",
      anywayAllowed: true,
      attentionCount: 1,
    },
  },
  {
    label: "denied maps to anyway_denied",
    response: {
      protocolMajor: 1,
      requestId: "request-send",
      state: "denied",
      context: [],
    },
    expected: { accepted: false, sideEffectDecision: "anyway_denied" },
  },
];

test.each(sendAdapterCases)(
  "adapts the send route's AgentSendResponse ($label) into the transport shape",
  async ({ response, expected }) => {
    const fake = fakeClient();
    const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
      requestSend: async () => response,
    });
    await transport.start("daemon-token", {
      ...config,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    });
    const result = await transport.agentMessage({
      protocolMajor: 1,
      requestId: "request-send",
      workspaceId: config.workspaceId,
      agentId: "agent-1",
      operation: "send",
      target: "@ada",
      body: "hi",
    });
    expect(result).toMatchObject(expected);
    expect(result.messages).toEqual(response.context);
  },
);

test("requestSend rejects a response whose state is not sent/held/denied instead of returning it untyped", async () => {
  // The exact incident: upstream answers 200, but the body has no `state` (or `context`) the
  // daemon can trust. Previously this fell through to a `TypeError` deep in `runtime.ts`.
  for (const malformedBody of [
    { protocolMajor: 1, requestId: "request-send" }, // missing state and context entirely
    { protocolMajor: 1, requestId: "request-send", state: "sent" }, // missing context
    { protocolMajor: 1, requestId: "request-send", state: "queued", context: [] }, // unknown state
    "not an object",
  ]) {
    const client = createAgentMessageHttpClient(async () => Response.json(malformedBody));
    const attempt = client.requestSend!({
      url: "https://server.example/api/agent/v1/messages",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {
        protocolMajor: 1,
        requestId: "request-send",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        operation: "send",
        target: "@ada",
        body: "hi",
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(AgentTransportError);
    await expect(attempt).rejects.toMatchObject({
      failureClass: "protocol_mismatch",
      upstreamStatus: 200,
      responseStarted: true,
      responseComplete: true,
    });
  }
});

test("requestSend classifies a network failure as pre-response transport, never a bare exception", async () => {
  const client = createAgentMessageHttpClient(async () => {
    throw new TypeError("fetch failed");
  });
  const attempt = client.requestSend!({
    url: "https://server.example/api/agent/v1/messages",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-send",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "send",
      target: "@ada",
      body: "hi",
    },
  });
  await expect(attempt).rejects.toBeInstanceOf(AgentTransportError);
  await expect(attempt).rejects.toMatchObject({
    failureClass: "pre_response_transport",
    responseStarted: false,
    responseComplete: false,
  });
});

test("requestSend on a non-2xx upstream response surfaces the real status, not a collapsed 502", async () => {
  const client = createAgentMessageHttpClient(
    async () => new Response("internal error", { status: 500 }),
  );
  const attempt = client.requestSend!({
    url: "https://server.example/api/agent/v1/messages",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-send",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "send",
      target: "@ada",
      body: "hi",
    },
  });
  await expect(attempt).rejects.toBeInstanceOf(AgentTransportError);
  await expect(attempt).rejects.toMatchObject({
    failureClass: "upstream_http_response",
    upstreamStatus: 500,
    responseStarted: true,
    responseComplete: true,
  });
});

afterEach(() => {
  mock.restore();
});

test("defaultAgentChannelHttpClient on a non-2xx upstream response surfaces the real status (e.g. 404 'channel not found'), not a collapsed 502", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("channel not found", { status: 404 }));
  const attempt = defaultAgentChannelHttpClient.execute({
    url: "https://server.example/api/agent/v1/channels/%23missing/join",
    method: "POST",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-channel",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "join",
      target: "#missing",
    },
  });
  await expect(attempt).rejects.toBeInstanceOf(AgentTransportError);
  await expect(attempt).rejects.toMatchObject({
    failureClass: "upstream_http_response",
    upstreamStatus: 404,
  });
});

test("defaultAgentChannelHttpClient classifies a network failure as pre-response transport, never a bare exception", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  const attempt = defaultAgentChannelHttpClient.execute({
    url: "https://server.example/api/agent/v1/channels/%23eng/join",
    method: "POST",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-channel",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "join",
      target: "#eng",
    },
  });
  await expect(attempt).rejects.toBeInstanceOf(AgentTransportError);
  await expect(attempt).rejects.toMatchObject({ failureClass: "pre_response_transport" });
});

test("defaultAgentChannelHttpClient returns the parsed JSON body on a 2xx response", async () => {
  const rawResponse = {
    protocolMajor: 1,
    requestId: "request-channel",
    target: "#eng",
    joined: true,
    alreadyJoined: false,
  };
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json(rawResponse));
  const result = await defaultAgentChannelHttpClient.execute({
    url: "https://server.example/api/agent/v1/channels/%23eng/join",
    method: "POST",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      protocolMajor: 1,
      requestId: "request-channel",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "join",
      target: "#eng",
    },
  });
  expect(result).toEqual(rawResponse);
});

test("DaemonConnection.agentChannel routes a 404 through the same AgentTransportError classification as agentMessage/agentTask", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("channel not found", { status: 404 }));
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  const attempt = transport.agentChannel(
    {
      protocolMajor: 1,
      requestId: "request-channel",
      workspaceId: config.workspaceId,
      agentId: "agent-1",
      operation: "join",
      target: "#missing",
    },
    `sk_agent_${"a".repeat(43)}`,
  );
  await expect(attempt).rejects.toBeInstanceOf(AgentTransportError);
  await expect(attempt).rejects.toMatchObject({
    failureClass: "upstream_http_response",
    upstreamStatus: 404,
  });
});

test("forwards a multipart attachment upload with its original content-type and Agent auth headers", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    method: string | undefined;
    contentType: string | null;
    authorization: string | null;
    agentApiKey: string | null;
    body: string;
  }> = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers);
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof Blob
            ? await init.body.text()
            : String(init?.body);
      requests.push({
        url: String(input),
        method: init?.method,
        contentType: headers.get("content-type"),
        authorization: headers.get("authorization"),
        agentApiKey: headers.get("x-coforge-agent-api-key"),
        body,
      });
      return Response.json({
        id: "attachment-1",
        fileName: "note.txt",
        contentType: "text/plain",
        sizeBytes: 4,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const transport = new DaemonConnection("wss://cloud.example", () => fakeClient().client);
    await transport.start("daemon-token", {
      ...config,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    });
    const request = new Request("http://local-proxy.test/api/agent/v1/attachments", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=b" },
      body: "multipart body",
    });
    const response = await transport.agentAttachmentUpload(request, `sk_agent_${"a".repeat(43)}`);
    expect(await response.json()).toEqual({
      id: "attachment-1",
      fileName: "note.txt",
      contentType: "text/plain",
      sizeBytes: 4,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(requests).toEqual([
    {
      url: "https://server.example/api/agent/v1/attachments",
      method: "POST",
      contentType: "multipart/form-data; boundary=b",
      authorization: "Bearer daemon-token",
      agentApiKey: `Bearer sk_agent_${"a".repeat(43)}`,
      body: "multipart body",
    },
  ]);
});

test("forwards each direct-upload session route to its cloud JSON route with Agent auth headers", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    method: string | undefined;
    contentType: string | null;
    authorization: string | null;
    agentApiKey: string | null;
    body: string;
  }> = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method,
        contentType: headers.get("content-type"),
        authorization: headers.get("authorization"),
        agentApiKey: headers.get("x-coforge-agent-api-key"),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Response.json({ uploadId: "upload-1" });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const transport = new DaemonConnection("wss://cloud.example", () => fakeClient().client);
    await transport.start("daemon-token", {
      ...config,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    });
    const apiKey = `sk_agent_${"a".repeat(43)}`;
    await transport.agentAttachmentUploadSessionCreate({ target: "#general" }, apiKey);
    await transport.agentAttachmentUploadSessionComplete("upload-1", apiKey);
    await transport.agentAttachmentUploadSessionCancel("upload-1", apiKey);
    await transport.agentAttachmentUploadSessionGet("upload-1", apiKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const authHeaders = {
    authorization: "Bearer daemon-token",
    agentApiKey: `Bearer sk_agent_${"a".repeat(43)}`,
  };
  expect(requests).toEqual([
    {
      url: "https://server.example/api/agent/v1/attachment-upload-sessions",
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ target: "#general" }),
      ...authHeaders,
    },
    {
      url: "https://server.example/api/agent/v1/attachment-upload-sessions/upload-1/complete",
      method: "POST",
      contentType: null,
      body: "",
      ...authHeaders,
    },
    {
      url: "https://server.example/api/agent/v1/attachment-upload-sessions/upload-1",
      method: "DELETE",
      contentType: null,
      body: "",
      ...authHeaders,
    },
    {
      url: "https://server.example/api/agent/v1/attachment-upload-sessions/upload-1",
      method: undefined,
      contentType: null,
      body: "",
      ...authHeaders,
    },
  ]);
});

test("requests and revokes Agent API keys through the server API route", async () => {
  const fake = fakeClient();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });
      return Response.json(
        init?.method === "POST"
          ? {
              apiKey: `sk_agent_${"a".repeat(43)}`,
              providerConfig: {
                kind: "coforge",
                providerId: "deepseek",
                apiKey: "sk-deepseek-secret",
              },
            }
          : { revoked: true },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
    await transport.start("daemon-token", {
      ...config,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    });
    const launchConfig = await transport.requestAgentLaunchConfig({
      agentId: "agent-1",
      workspaceId: config.workspaceId,
    });
    expect(launchConfig.providerConfig).toEqual({
      kind: "coforge",
      providerId: "deepseek",
      apiKey: "sk-deepseek-secret",
    });
    expect(launchConfig.envVars).toEqual({});
    await transport.revokeAgentApiKey(launchConfig.agentApiKey);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(requests).toEqual([
    {
      url: "https://server.example/api/agent-api-keys",
      method: "POST",
      authorization: "Bearer daemon-token",
    },
    {
      url: "https://server.example/api/agent-api-keys",
      method: "DELETE",
      authorization: "Bearer daemon-token",
    },
  ]);
});

test("validates explicit launch environment and preserves provider keys and empty values", async () => {
  const originalFetch = globalThis.fetch;
  const transport = new DaemonConnection("wss://cloud.example", () => fakeClient().client);
  await transport.start("daemon-token", { ...config, serverHttpUrl: "https://server.example" });
  try {
    for (const envVars of [
      { TOKEN: "secret", HTTPS_PROXY: "https://proxy", EMPTY: "" },
      null,
      [],
      { PATH: "secret" },
      { COFORGE_API_KEY: "secret" },
      { A: "secret\0" },
      { A: 1 },
      { "BAD=NAME": "secret" },
      { A: "s".repeat(32769) },
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`A${i}`, "s"])),
    ]) {
      globalThis.fetch = Object.assign(
        async () => Response.json({ apiKey: `sk_agent_${"a".repeat(43)}`, envVars }),
        { preconnect: originalFetch.preconnect },
      );
      const result = transport.requestAgentLaunchConfig({
        agentId: "agent-1",
        workspaceId: config.workspaceId,
      });
      if (envVars && "TOKEN" in envVars) expect((await result).envVars).toEqual(envVars);
      else await expect(result).rejects.toThrow("invalid Agent environment response");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-canonical runtime provider config from the server", async () => {
  const fake = fakeClient();
  const originalFetch = globalThis.fetch;
  try {
    for (const providerConfig of [
      { kind: "custom", providerId: "deepseek", apiKey: "secret-key" },
      { kind: "coforge", apiKey: "secret-key" },
      { kind: "default", providerId: "deepseek" },
      { kind: "default", apiKey: "secret-key" },
    ]) {
      globalThis.fetch = Object.assign(
        async () => Response.json({ apiKey: `sk_agent_${"a".repeat(43)}`, providerConfig }),
        { preconnect: originalFetch.preconnect },
      );
      const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
      await transport.start("daemon-token", {
        ...config,
        serverHttpUrl: "https://server.example/api/internal/centrifugo",
      });
      await expect(
        transport.requestAgentLaunchConfig({
          agentId: "agent-1",
          workspaceId: config.workspaceId,
        }),
      ).rejects.toThrow("invalid Agent runtime provider config response");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decodes a well-formed Agent launch identity, trimmed and with empty sub-objects dropped", async () => {
  const fake = fakeClient();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        apiKey: `sk_agent_${"a".repeat(43)}`,
        identity: {
          name: "  scout  ",
          displayName: "Scout",
          description: "  Reviews pull requests.  ",
          runtimeContext: {
            workspaceId: "workspace-a",
            workspaceSlug: "acme",
            workspaceName: "Acme",
            computerId: "computer-a",
            computerName: "Builder Box",
            computerOs: "darwin 15.6",
            computerVersion: "0.1.0-dev.40",
          },
        },
      }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
    await transport.start("daemon-token", {
      ...config,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    });
    const launchConfig = await transport.requestAgentLaunchConfig({
      agentId: "agent-1",
      workspaceId: config.workspaceId,
    });
    expect(launchConfig.identity).toEqual({
      name: "scout",
      displayName: "Scout",
      description: "Reviews pull requests.",
      runtimeContext: {
        workspaceId: "workspace-a",
        workspaceSlug: "acme",
        workspaceName: "Acme",
        computerId: "computer-a",
        computerName: "Builder Box",
        computerOs: "darwin 15.6",
        computerVersion: "0.1.0-dev.40",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a missing or entirely malformed Agent launch identity yields undefined and never fails the launch", async () => {
  const fake = fakeClient();
  const originalFetch = globalThis.fetch;
  try {
    for (const identity of [
      undefined,
      null,
      "scout",
      42,
      [],
      {},
      { name: 42, displayName: null, description: [] },
      { name: "s".repeat(81) },
      { description: "d".repeat(2001) },
      { runtimeContext: "not-an-object" },
      { runtimeContext: { workspaceId: 1, computerName: "s".repeat(201) } },
    ]) {
      globalThis.fetch = Object.assign(
        async () => Response.json({ apiKey: `sk_agent_${"a".repeat(43)}`, identity }),
        { preconnect: originalFetch.preconnect },
      );
      const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
      await transport.start("daemon-token", {
        ...config,
        serverHttpUrl: "https://server.example/api/internal/centrifugo",
      });
      const launchConfig = await transport.requestAgentLaunchConfig({
        agentId: "agent-1",
        workspaceId: config.workspaceId,
      });
      expect(launchConfig.identity).toBeUndefined();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an identity with one garbage field and one valid field keeps only the valid field", async () => {
  const fake = fakeClient();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        apiKey: `sk_agent_${"a".repeat(43)}`,
        identity: {
          name: 42,
          runtimeContext: { workspaceId: 1, computerName: "Builder Box" },
        },
      }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
    await transport.start("daemon-token", {
      ...config,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    });
    const launchConfig = await transport.requestAgentLaunchConfig({
      agentId: "agent-1",
      workspaceId: config.workspaceId,
    });
    expect(launchConfig.identity).toEqual({ runtimeContext: { computerName: "Builder Box" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconnect ready retries back off exponentially up to a minute", async () => {
  const fake = fakeClient();
  let readyCalls = 0;
  let retryReady!: () => void;
  const delays: number[] = [];
  fake.client.rpc = async (method) => {
    if (method === DAEMON_RUNTIME_READY_METHOD && ++readyCalls >= 2)
      throw new Error("reconnect ready failed");
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, undefined, {
    schedule: (callback, delayMs) => {
      retryReady = callback;
      delays.push(delayMs);
      return 1;
    },
    cancel: () => {},
  });
  await transport.start("secret", config);
  await transport.ready(() => ({
    protocolMajor: 1,
    requestId: `ready-${readyCalls + 1}`,
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds: [],
  }));

  fake.connect();
  await Bun.sleep(0);
  for (let i = 0; i < 7; i++) {
    retryReady();
    await Bun.sleep(0);
  }

  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  await transport.stop();
});

test("reports one Computer upgrade result through its RPC method and replays it at most once", async () => {
  const fake = fakeClient();
  const calls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push({ method, data });
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  const result = {
    protocolMajor: 1,
    requestId: "operation-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    status: "failed" as const,
    completedAtMs: 1_700_000_000_000,
    error:
      "candidate failed at /Users/someone/.coforge/computer/install; token abcdefghijklmnopqrstuvwxyz",
  };

  expect(await transport.sendUpgradeResult(result)).toBe(true);
  // A retried report for the same operation is dropped rather than re-sent.
  expect(await transport.sendUpgradeResult(result)).toBe(false);

  const sent = calls.filter(({ method }) => method === COMPUTER_UPGRADE_RESULT_METHOD);
  expect(sent).toHaveLength(1);
  const decoded = decodeComputerUpgradeResult(sent[0]!.data);
  expect(decoded.requestId).toBe("operation-1");
  expect(decoded.status).toBe("failed");
  expect(decoded.completedAtMs).toBe(1_700_000_000_000);
  // The wire form carries no local paths and nothing shaped like a credential.
  expect(decoded.error).not.toContain("/Users/");
  expect(decoded.error).toContain("<path>");
  expect(decoded.error).toContain("<redacted>");
});

test("a failed Computer upgrade report stays replayable", async () => {
  const fake = fakeClient();
  let attempts = 0;
  fake.client.rpc = async (method) => {
    if (method === COMPUTER_UPGRADE_RESULT_METHOD && attempts++ === 0)
      throw new Error("server unavailable");
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", config);
  const result = {
    protocolMajor: 1,
    requestId: "operation-2",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    status: "succeeded" as const,
    completedAtMs: 1_700_000_000_001,
    version: "0.1.0-dev.29",
  };

  await expect(transport.sendUpgradeResult(result)).rejects.toThrow("server unavailable");
  expect(await transport.sendUpgradeResult(result)).toBe(true);
  expect(attempts).toBe(2);
});
