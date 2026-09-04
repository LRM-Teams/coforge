import { expect, test } from "bun:test";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";
import {
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_STATUS_METHOD,
  decodeAgentActivity,
  decodeAgentStatus,
  decodeAgentMessageDeliveryAck,
  encodeAgentStartIntent,
} from "@coforge/protocol";
import { DAEMON_RUNTIME_READY_METHOD } from "@coforge/protocol";

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
    activity: "using_tool",
    level: "info",
    message: "Running a tool",
    occurredAt: "2026-08-29T00:00:00.000Z",
    launchId: "launch-1",
    clientSeq: 1,
  } as const;

  expect(transport.sendAgentActivity(activity)).toBeUndefined();
  await Promise.resolve();

  expect(publications).toHaveLength(1);
  expect(publications[0]?.channel).toBe(`activity:${config.workspaceId}`);
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
  });
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
      activity: "starting",
      level: "info",
      message: "Starting",
      occurredAt: "2026-08-29T00:00:00.000Z",
      launchId: "launch-1",
      clientSeq: 1,
    }),
  ).toBeUndefined();
  expect(publications).toBe(0);
});

test("retains only each Agent's newest activity while disconnected and flushes on reconnect", async () => {
  const fake = fakeClient();
  const publications: import("@coforge/protocol").AgentActivity[] = [];
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
      activity: "using_tool",
      level: "info",
      message: "latest",
      occurredAt: "2026-08-29T00:00:00.000Z",
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

const config = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
};

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
  await transport.ready({
    protocolMajor: 1,
    requestId: "ready-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
  });

  fake.connect();
  await reconnected;

  expect(readyCalls).toHaveLength(2);
  expect(readyCalls[1]).toEqual(readyCalls[0]!);
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

  fake.publish("daemon:other-computer", data);
  fake.publish(`daemon:${config.computerId}`, data);

  expect(started).toEqual(["agent-1"]);
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
  await transport.ready({
    protocolMajor: 1,
    requestId: "ready-1",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
  });

  fake.connect();
  await Promise.resolve();
  fake.connect();
  await Promise.resolve();

  expect(readyCalls).toBe(3);
});

test("uses the configured HTTP seam for Agent messages and never falls back to WS", async () => {
  const fake = fakeClient();
  const requests: unknown[] = [];
  const response = {
    protocolMajor: 1,
    requestId: "request-2",
    accepted: true,
    attentionCount: 0,
    messages: [],
    messageId: "",
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    request: async (input) => {
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
    url: "https://server.example/api/agent-messages",
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
