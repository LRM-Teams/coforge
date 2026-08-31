import { describe, expect, test } from "bun:test";
import {
  CentrifugoRpcAuthenticationError,
  CentrifugoRpcHandler,
  createAgentMessageMethod,
  createWorkspaceWorkerCodeAgentsUpdateMethod,
  createWorkspaceWorkerReadyMethod,
  type CentrifugoRpcMethod,
} from "../src/server/centrifugo/rpc-handler.server";
import { createCentrifugoRpcHandler } from "../src/server/centrifugo/rpc-composition.server";
import {
  decodeCloudAgentMessageResponse,
  encodeAgentMessageRequest,
  encodeWorkspaceWorkerCodeAgentsUpdateRequest,
  encodeWorkspaceWorkerReadyRequest,
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
  test("replaces the exact Computer's external Code Agent snapshot", async () => {
    const updates: unknown[] = [];
    const method = createWorkspaceWorkerCodeAgentsUpdateMethod({
      replace: async (scope, runtimes, catalogs) => updates.push({ scope, runtimes, catalogs }),
    });
    const payload = encodeWorkspaceWorkerCodeAgentsUpdateRequest({
      protocolMajor: 1,
      requestId: "inventory-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      runtimes: [{ provider: "codex", version: "0.151.0", kind: "external" }],
      catalogs: [{ provider: "codex", models: [] }],
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(updates).toEqual([
      {
        scope: { workspaceId: "workspace-1", computerId: "computer-1" },
        runtimes: [{ provider: "codex", version: "0.151.0", kind: "external" }],
        catalogs: [{ provider: "codex", models: [] }],
      },
    ]);
    expect(
      await method(payload, { principal: { ...principal(), computerId: "computer-2" } }),
    ).toEqual({ code: 403, message: "workspace worker identity is not authorized" });
  });

  test("starts every existing Workspace Agent after the exact Computer reports ready", async () => {
    const recovered: string[][] = [];
    const method = createWorkspaceWorkerReadyMethod({
      recoverWorkspace: async (workspaceId, computerId) => {
        recovered.push([workspaceId, computerId]);
      },
    });
    const payload = encodeWorkspaceWorkerReadyRequest({
      protocolMajor: 1,
      requestId: "ready-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workerInstanceId: "worker-1",
      startedAt: 1,
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(recovered).toEqual([["workspace-1", "computer-1"]]);
    expect(
      await method(payload, {
        principal: { ...principal(), computerId: "another-computer" },
      }),
    ).toEqual({ code: 403, message: "workspace worker identity is not authorized" });
    expect(recovered).toEqual([["workspace-1", "computer-1"]]);
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
    const method = createAgentMessageMethod(
      {
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
    );

    const result = await method(agentMessagePayload("agent-a", "send"), {
      principal: principal("agent-a"),
    });
    expect(result).toBeInstanceOf(Uint8Array);
    if (!(result instanceof Uint8Array)) throw new Error("expected an Agent message response");
    expect(decodeCloudAgentMessageResponse(result)).toMatchObject({
      requestId: "request-1",
      accepted: true,
      messageId: "message-1",
    });
  });

  test("composed protocol methods fail closed until persistence is wired", async () => {
    const handler = createCentrifugoRpcHandler();
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
