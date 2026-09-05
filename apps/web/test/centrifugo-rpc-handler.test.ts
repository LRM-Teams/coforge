import { describe, expect, test } from "bun:test";
import {
  CentrifugoRpcAuthenticationError,
  CentrifugoRpcHandler,
  createAgentDeliveryAckMethod,
  createAgentMessageMethod,
  createAgentStatusMethod,
  createDaemonRuntimeCodeAgentsUpdateMethod,
  createDaemonRuntimeReadyMethod,
  createDaemonRuntimeUsageScanResultMethod,
  type CentrifugoRpcMethod,
} from "../src/server/centrifugo/rpc-handler.server";
import { createCentrifugoRpcHandler } from "../src/server/centrifugo/rpc-composition.server";
import {
  decodeCloudAgentMessageResponse,
  encodeAgentMessageDeliveryAck,
  encodeAgentStatus,
  encodeAgentMessageRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  encodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeUsageScanResponse,
} from "@coforge/protocol";

const encoded = (value: string) => btoa(value);
const json = (value: unknown) =>
  new Request("http://handler", {
    method: "POST",
    body: JSON.stringify(value),
  });
const authorizedJson = (value: unknown) =>
  new Request("http://handler", {
    method: "POST",
    headers: { "x-coforge-centrifugo-proxy-secret": "test-secret" },
    body: JSON.stringify(value),
  });

const agentMessagePayload = (agentId: string, operation: "read" | "send") =>
  encodeAgentMessageRequest({
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    agentId,
    operation,
    target: "@user",
    body: operation === "send" ? "Hello" : undefined,
  });

const principal = (agentId?: string) => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
});

describe("CentrifugoRpcHandler", () => {
  test("authorizes delivery ACKs against the authenticated Computer", async () => {
    const received: unknown[] = [];
    const method = createAgentDeliveryAckMethod({
      async receiveDeliveryAck(input) {
        if (input.computerId !== "computer-1") throw new Error("wrong Computer");
        received.push(input);
      },
    });
    const payload = encodeAgentMessageDeliveryAck({
      protocolMajor: 1,
      method: "agent:deliver:ack",
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      messageId: "message-1",
      sequence: 1,
    });

    expect(
      await method(payload, { principal: { ...principal(), computerId: "computer-2" } }),
    ).toEqual({ code: 403, message: "delivery acknowledgement is not authorized" });
    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ computerId: "computer-1", deliveryId: "delivery-1" });
  });

  test("accepts a scoped Agent status from its assigned Computer", async () => {
    const statuses: unknown[] = [];
    const publications: unknown[] = [];
    const method = createAgentStatusMethod(
      {
        getById: async () => ({
          id: "agent-1",
          workspaceId: "workspace-1",
          ownerId: "another-workspace-member",
          computerId: "computer-1",
        }),
      },
      {
        put: async (status) => {
          statuses.push(status);
          return true;
        },
        get: async () => "inactive",
        snapshot: async () => undefined,
      },
      {
        publish: async (channel, data) => {
          publications.push({ channel, data: JSON.parse(new TextDecoder().decode(data)) });
        },
      },
      () => 1_000,
    );
    const payload = encodeAgentStatus({
      protocolMajor: 1,
      requestId: "status-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      status: "active",
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      observedAtMs: 1_000,
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(statuses).toEqual([
      {
        protocolMajor: 1,
        requestId: "status-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        agentId: "agent-1",
        status: "active",
        daemonInstanceId: "daemon-1",
        clientSeq: 1,
        observedAtMs: 1_000,
      },
    ]);
    expect(publications).toEqual([
      {
        channel: "status:workspace-1",
        data: {
          agentId: "agent-1",
          status: "active",
          expiresAt: 91_000,
          daemonInstanceId: "daemon-1",
          clientSeq: 1,
          observedAtMs: 1_000,
        },
      },
    ]);
    expect(
      await method(payload, { principal: { ...principal(), computerId: "computer-2" } }),
    ).toEqual({ code: 403, message: "Agent status is not authorized" });
  });

  test("does not publish stale handler input", async () => {
    const publications: unknown[] = [];
    const method = createAgentStatusMethod(
      { getById: async () => ({ workspaceId: "workspace-1", computerId: "computer-1" }) },
      { put: async () => false, get: async () => "active", snapshot: async () => undefined },
      {
        publish: async (...args) => {
          publications.push(args);
        },
      },
    );
    await method(
      encodeAgentStatus({
        protocolMajor: 1,
        requestId: "stale",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        agentId: "agent-1",
        status: "inactive",
        daemonInstanceId: "daemon-1",
        clientSeq: 1,
        observedAtMs: 1,
      }),
      { principal: principal() },
    );
    expect(publications).toEqual([]);
  });

  test("replaces the exact Computer's external Code Agent snapshot", async () => {
    const updates: unknown[] = [];
    const method = createDaemonRuntimeCodeAgentsUpdateMethod({
      replace: async (scope, runtimes, catalogs) => updates.push({ scope, runtimes, catalogs }),
    });
    const payload = encodeDaemonRuntimeCodeAgentsUpdateRequest({
      protocolMajor: 1,
      requestId: "inventory-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      catalogs: [{ provider: "codex", models: [] }],
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(updates).toEqual([
      {
        scope: { workspaceId: "workspace-1", computerId: "computer-1" },
        runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        catalogs: [{ provider: "codex", models: [] }],
      },
    ]);
    expect(
      await method(payload, { principal: { ...principal(), computerId: "computer-2" } }),
    ).toEqual({ code: 403, message: "daemon runtime identity is not authorized" });
  });

  test("starts every existing Workspace Agent after the exact Computer reports ready", async () => {
    const recovered: unknown[][] = [];
    const method = createDaemonRuntimeReadyMethod({
      recoverWorkspace: async (workspaceId, computerId, runningAgentIds) => {
        recovered.push([workspaceId, computerId, runningAgentIds]);
      },
    });
    const payload = encodeDaemonRuntimeReadyRequest({
      protocolMajor: 1,
      requestId: "ready-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workerInstanceId: "worker-1",
      startedAt: 1,
      runningAgentIds: ["agent-running"],
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(recovered).toEqual([["workspace-1", "computer-1", ["agent-running"]]]);
    expect(
      await method(payload, {
        principal: { ...principal(), computerId: "another-computer" },
      }),
    ).toEqual({ code: 403, message: "daemon runtime identity is not authorized" });
    expect(recovered).toEqual([["workspace-1", "computer-1", ["agent-running"]]]);
  });

  test("stores an available Daemon usage result as available", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async put(record) {
        records.push(record);
      },
      async get() {
        return undefined;
      },
    });
    const snapshot = {
      provider: "codex",
      planType: "pro",
      primary: {
        usedPercent: 25,
        windowDurationMinutes: 300,
        resetsAt: "2026-09-04T03:00:00.000Z",
      },
    };
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "codex",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(records).toEqual([
      {
        workspaceId: "workspace-1",
        computerId: "computer-1",
        provider: "codex",
        scanId: "usage-1",
        status: "available",
        message: undefined,
        snapshot,
      },
    ]);
  });

  test("rejects an invalid Daemon usage snapshot", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async put(record) {
        records.push(record);
      },
      async get() {
        return undefined;
      },
    });
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-invalid",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "codex",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(
        JSON.stringify({
          provider: "claude-code",
          primary: {
            usedPercent: 101,
            windowDurationMinutes: 300,
            resetsAt: "not-a-date",
          },
        }),
      ),
    });

    expect(await method(payload, { principal: principal() })).toEqual({
      code: 400,
      message: "invalid usage scan result",
    });
    expect(records).toEqual([]);
  });

  test("rejects Agent message access by a Daemon principal without an Agent identity", async () => {
    const method = createAgentMessageMethod({}, {}, "read", {
      async canUseAgent() {
        return true;
      },
    });

    expect(
      await method(agentMessagePayload("agent-a", "read"), { principal: principal() }),
    ).toEqual({ code: 403, message: "agent identity is not authorized" });
  });

  test("rejects an Agent A credential sending as Agent B", async () => {
    const method = createAgentMessageMethod({}, {}, "send", {
      async canUseAgent() {
        return true;
      },
    });

    expect(
      await method(agentMessagePayload("agent-b", "send"), { principal: principal("agent-a") }),
    ).toEqual({ code: 403, message: "agent identity is not authorized" });
  });

  test("allows a matching Agent API key to send", async () => {
    const advances: unknown[] = [];
    const method = createAgentMessageMethod(
      {
        async advanceAgentReadThrough(...args: unknown[]) {
          advances.push(args);
          return 5;
        },
        async readPendingAgentContext(...args: unknown[]) {
          advances.push(["pending", ...args]);
          return [];
        },
        async userIdForUsername() {
          return "target-user";
        },
        async getOrCreateUserAgent() {
          return { id: "conversation-1" };
        },
        async sendAgentMessage() {
          return { id: "message-1" };
        },
      },
      {},
      "send",
      {
        async canUseAgent() {
          return true;
        },
      },
      {
        async execute(_scope, persist) {
          return persist();
        },
      },
      {
        async issue() {
          return "unused";
        },
        async get() {
          return undefined;
        },
        async consume() {
          return false;
        },
      },
    );

    const result = await method(
      encodeAgentMessageRequest({
        protocolMajor: 1,
        requestId: "request-1",
        workspaceId: "workspace-1",
        agentId: "agent-a",
        operation: "send",
        target: "@user",
        body: "Hello",
        seenUpToSequence: 7,
      }),
      {
        principal: principal("agent-a"),
      },
    );
    expect(result).toBeInstanceOf(Uint8Array);
    if (!(result instanceof Uint8Array)) throw new Error("expected an Agent message response");
    expect(decodeCloudAgentMessageResponse(result)).toMatchObject({
      requestId: "request-1",
      accepted: true,
      messageId: "message-1",
    });
    expect(advances).toEqual([
      ["workspace-1", "agent-a", "@user", 7],
      ["pending", "workspace-1", "agent-a", "@user", 5],
    ]);
  });

  test("fails closed when a trusted seen sequence cannot be advanced", async () => {
    const method = createAgentMessageMethod({}, {}, "send", {
      async canUseAgent() {
        return true;
      },
    });
    await expect(
      method(
        encodeAgentMessageRequest({
          protocolMajor: 1,
          requestId: "request-1",
          workspaceId: "workspace-1",
          agentId: "agent-a",
          operation: "send",
          target: "@user",
          body: "Hello",
          seenUpToSequence: 7,
        }),
        { principal: principal("agent-a") },
      ),
    ).rejects.toThrow("advancement is unavailable");
  });

  test("composed protocol methods fail closed until persistence is wired", async () => {
    // Pass null so the assertion holds whether or not DATABASE_URL is set in
    // the developer's environment.
    const handler = createCentrifugoRpcHandler(null);
    const previous = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
    process.env.COFORGE_CENTRIFUGO_PROXY_SECRET = "test-secret";
    const result = await handler.handleRequest(
      authorizedJson({ method: "workspace:list", b64data: "AA==", user: "user-1" }),
    );
    if (previous === undefined) delete process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
    expect(await result.json()).toEqual({
      error: { code: 503, message: "protocol method dependencies are unavailable" },
    });
  });

  test("rejects an unauthenticated internal proxy request", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: { echo: () => new Uint8Array([1]) },
      authorizeProxyRequest: () => {
        throw new Error("not trusted");
      },
    });
    const result = await handler.handleRequest(json({ method: "echo", b64data: "AA==" }));
    expect(await result.json()).toEqual({
      error: { code: 403, message: "RPC request is not authorized" },
    });
  });

  test("maps a missing authenticated Centrifugo user to 401", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: { echo: () => new Uint8Array([1]) },
      authenticateEnvelope: (request) => {
        if (!request.user) throw new CentrifugoRpcAuthenticationError();
        throw new Error("test callback must not authenticate this request");
      },
    });
    const result = await handler.handleRequest(json({ method: "echo", b64data: "AA==" }));
    expect(await result.json()).toEqual({
      error: { code: 401, message: "authentication required" },
    });
  });

  test("round trips binary payload and passes envelope metadata", async () => {
    const method: CentrifugoRpcMethod = (payload, metadata) => {
      expect([...payload]).toEqual([0, 255, 42]);
      expect(metadata.principal.userId).toBe("user-1");
      expect(metadata.client).toBe("connection-1");
      return payload;
    };
    const handler = new CentrifugoRpcHandler({ methods: { echo: method } });
    const result = await handler.handleRequest(
      json({ method: "echo", user: "user-1", client: "connection-1", b64data: encoded("\0ÿ*") }),
    );
    expect(await result.json()).toEqual({ result: { b64data: encoded("\0ÿ*") } });
  });

  test("rejects unknown and malformed requests", async () => {
    const handler = new CentrifugoRpcHandler({ methods: {} });
    expect(
      await (await handler.handleRequest(json({ method: "nope", b64data: "AA==" }))).json(),
    ).toEqual({ error: { code: 404, message: "unknown RPC method" } });
    expect(
      await (
        await handler.handleRequest(new Request("http://handler", { method: "POST", body: "{" }))
      ).json(),
    ).toEqual({ error: { code: 400, message: "invalid RPC request" } });
  });

  test("maps handler errors without exposing secrets", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: {
        boom: () => {
          throw new Error("token=super-secret");
        },
      },
    });
    const body = JSON.stringify(
      await (await handler.handleRequest(json({ method: "boom", b64data: "AA==" }))).json(),
    );
    expect(body).toBe('{"error":{"code":500,"message":"RPC method failed"}}');
    expect(body).not.toContain("super-secret");
  });
});
