import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "../src/agent-proxy";
import { AgentMessageRequestError } from "../src/connection/agent-message-request-error";
import { AgentTaskRequestError } from "../src/connection/agent-task-request-error";
import { AgentPreflightError } from "../src/daemon-runtime/agent-preflight-error";
import { AgentTransportError } from "../src/connection/agent-transport-error";
import { AgentManualRequestError } from "../src/connection/agent-manual-request-error";
import type { AgentProxyFailureBody } from "../src/agent-proxy-failure";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

test("proxy classifies Agent message failures: known validation passes through, upstream HTTP status passes through", async () => {
  for (const [failure, status, expected] of [
    [
      AgentMessageRequestError.fromRpc(400, "ambiguous message prefix; use the full UUID"),
      400,
      {
        error: "ambiguous message prefix; use the full UUID",
        code: "AGENT_MESSAGE_VALIDATION_FAILED",
      },
    ],
    [
      AgentMessageRequestError.fromRpc(500, "database password leaked"),
      500,
      { error: "upstream HTTP response failed", code: "agent_proxy_failed" },
    ],
  ] as const) {
    const proxy = startAgentProxy({
      runtime: {
        agentMessage: async () => {
          throw failure;
        },
      },
    });
    proxies.push(proxy);
    const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
    const response = await fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-1", operation: "read", target: "@ada" }),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("x-coforge-correlation-id")).toBeTruthy();
    const body = (await response.json()) as AgentProxyFailureBody;
    expect(body).toMatchObject(expected);
    expect(body.proxy.layer).toBe("local_daemon_proxy");
    expect(body.proxy.route_family).toBe("agent-api/read");
    // Never the bare, unlabeled 502 the incident produced.
    expect(body.error).not.toBe("proxy request failed");
    if (status === 500) expect(body.detail).not.toContain("database password leaked");
  }
});

test("proxy redacts known request errors in reviewer-isolated mode", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        throw AgentMessageRequestError.fromRpc(400, "sensitive message failure");
      },
      agentTask: async () => {
        throw new AgentTaskRequestError("sensitive task failure");
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(proxy.url.replace(agentApiRoutes.proxy.messages.path, path), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, freshnessContextMode: "withheld" }),
    });
  const message = await post(agentApiRoutes.proxy.messages.path, {
    requestId: "message",
    operation: "send",
    target: "@ada",
    body: "reply",
  });
  expect(message.status).toBe(502);
  const messageBody = (await message.json()) as AgentProxyFailureBody;
  expect(messageBody.detail).toBeUndefined();
  expect(JSON.stringify(messageBody)).not.toContain("sensitive message failure");
  const task = await post(agentApiRoutes.proxy.tasks.path, {
    requestId: "task",
    operation: "claim",
    target: "#general",
    number: 1,
  });
  expect(task.status).toBe(502);
  const taskBody = (await task.json()) as AgentProxyFailureBody;
  expect(taskBody.detail).toBeUndefined();
  expect(JSON.stringify(taskBody)).not.toContain("sensitive task failure");
});

test("proxy validates and forwards channel management commands, and 404s without a runtime handler", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentChannel: async (context, request) => {
        calls.push({ context, request });
        return { protocolMajor: 1, requestId: request.requestId, target: request.target };
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const post = (body: Record<string, unknown>) =>
    fetch(
      proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.channels.path),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  const ok = await post({ requestId: "r-1", operation: "info", target: "#general" });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ protocolMajor: 1, requestId: "r-1", target: "#general" });
  expect(calls).toEqual([
    {
      context: expect.any(String),
      request: { requestId: "r-1", operation: "info", target: "#general" },
    },
  ]);

  for (const badBody of [
    { requestId: "r-2", operation: "not-a-real-operation", target: "#general" },
    { requestId: "r-3", operation: "join" }, // missing target
    { requestId: "r-4", operation: "create" }, // missing name
    { requestId: "r-5", operation: "update", target: "#general" }, // missing name and description
    { requestId: "r-6", operation: "add-member", target: "#general" }, // neither user nor agent
    {
      requestId: "r-7",
      operation: "add-member",
      target: "#general",
      user: "@a",
      agent: "@b",
    }, // both user and agent
    { operation: "info", target: "#general" }, // missing requestId
  ]) {
    const rejected = await post(badBody);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe("bad request");
  }
});

test("proxy 404s a channel management request when the runtime has no handler", async () => {
  const proxy = startAgentProxy({ runtime: { agentMessage: async () => ({}) } });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.channels.path),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r-1", operation: "info", target: "#general" }),
    },
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("not found");
});

test("one shared proxy maps opaque per-Agent tokens and fails closed", async () => {
  const calls: Array<{ context: string; agentId: string }> = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: (agentId) => `context-${agentId}`,
      agentMessage: async (context, request) => {
        calls.push({ context, agentId: request.target ?? "" });
        return {
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [],
          messageId: "",
        };
      },
    },
  });
  proxies.push(proxy);
  const first = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const second = proxy.issue("agent-b", `sk_agent_${"b".repeat(43)}`);

  expect(first).not.toBe(second);
  expect(first).toMatch(/^sfp_[A-Za-z0-9_-]{43}$/);
  expect(second).toMatch(/^sfp_[A-Za-z0-9_-]{43}$/);
  expect(first).not.toContain("agent-a");
  const request = (token: string, target: string) =>
    fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        operation: "send",
        target,
        body: "hello",
      }),
    });
  expect((await request(first, "@a")).status).toBe(200);
  expect((await request(second, "@b")).status).toBe(200);
  expect(calls.map((call) => call.context)).toEqual(["context-agent-a", "context-agent-b"]);
  proxy.revoke(first);
  expect((await request(first, "@a")).status).toBe(401);
  expect((await request("expired-or-forged", "@a")).status).toBe(401);
  expect((await request(`sfp_${"a".repeat(42)}`, "@a")).status).toBe(401);
  expect((await request(`cf_proxy_${"a".repeat(43)}`, "@a")).status).toBe(401);
  const replacement = proxy.issue("agent-a", `sk_agent_${"c".repeat(43)}`);
  expect(replacement).not.toBe(first);
  expect((await request(first, "@a")).status).toBe(401);
  expect((await request(replacement, "@a")).status).toBe(200);
});

test("proxy registration rejects Local Proxy tokens as Agent API keys", () => {
  const proxy = startAgentProxy({ runtime: { agentMessage: async () => ({}) } });
  proxies.push(proxy);
  expect(() => proxy.issue("agent-a", `sfp_${"a".repeat(43)}`)).toThrow("invalid Agent API key");
  expect(() => proxy.issue("agent-a", `sk_agent_${"a".repeat(42)}`)).toThrow(
    "invalid Agent API key",
  );
});

test("proxy forwards workspace info with the token-bound Agent API key", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: (agentId) => agentId,
      agentMessage: async () => ({}),
      workspaceInfo: async (context, request, agentApiKey) => {
        calls.push({ context, protocolMajor: request.protocolMajor, agentApiKey });
        return { requestId: request.requestId, protocolMajor: 1 } as never;
      },
    },
  });
  proxies.push(proxy);
  const agentApiKey = `sk_agent_${"a".repeat(43)}`;
  const token = proxy.issue("agent-a", agentApiKey);
  const response = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.workspace.path),
    {
      method: agentApiRoutes.proxy.workspace.method,
      headers: { authorization: `Bearer ${token}` },
    },
  );

  expect(response.status).toBe(200);
  expect(calls).toEqual([{ context: "agent-a", protocolMajor: 1, agentApiKey }]);
});

test("proxy forwards validated GitHub credential requests without caching", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: (agentId) => agentId,
      agentMessage: async () => ({}),
      githubCredential: async (context, request, agentApiKey) => {
        calls.push({ context, request, agentApiKey });
        return {
          username: "x-access-token",
          password: "short-lived-token",
          expiresAt: "2026-09-16T21:00:00Z",
        };
      },
    },
  });
  proxies.push(proxy);
  const agentApiKey = `sk_agent_${"a".repeat(43)}`;
  const token = proxy.issue("agent-a", agentApiKey);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.proxy.githubCredentials.path,
    ),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ password: "short-lived-token" });
  expect(calls).toEqual([
    {
      context: "agent-a",
      request: {},
      agentApiKey,
    },
  ]);
});

test("proxy forwards Agent Manual get requests as a plain GET with query parameters", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: (agentId) => agentId,
      agentMessage: async () => ({}),
      manualGet: async (context, request) => {
        calls.push({ context, request });
        return {
          ok: true,
          docId: "github",
          topicOrPath: "github",
          docVersion: "abc123",
          docState: "published",
          contentType: "text/markdown",
          content: "# GitHub\n",
        };
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const endpoint = new URL(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.manual.get.path),
  );
  endpoint.searchParams.set("topic", "github");
  endpoint.searchParams.set("intent", "Open a pull request for the bound repository");
  endpoint.searchParams.set("reason", "Confirm the exact clone and push commands");
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, docId: "github" });
  expect(calls).toEqual([
    {
      context: "agent-a",
      request: {
        topic: "github",
        intent: "Open a pull request for the bound repository",
        reason: "Confirm the exact clone and push commands",
      },
    },
  ]);
});

test("proxy forwards an Agent Manual error response's errorCode unchanged, not the generic proxy-failure shape", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      manualSearch: async () => {
        throw new AgentManualRequestError(
          "knowledge_not_found",
          'No Manual topic matched "xyzzy".',
          404,
        );
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const endpoint = new URL(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.manual.search.path),
  );
  endpoint.searchParams.set("query", "xyzzy");
  endpoint.searchParams.set("intent", "Find a workflow that does not exist");
  endpoint.searchParams.set("reason", "Confirm the Manual has no such topic");
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    ok: false,
    errorCode: "knowledge_not_found",
    error: 'No Manual topic matched "xyzzy".',
  });
});

test("proxy forwards coforge version's local-only GET with the token-bound Agent API key", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: (agentId) => agentId,
      agentMessage: async () => ({}),
      version: async (context, request, agentApiKey) => {
        calls.push({ context, request, agentApiKey });
        return {
          ok: true,
          daemonVersion: "0.1.0-dev.38",
          computerVersion: "0.1.0-dev.38",
          daemonPid: 4242,
          startedAt: 1_726_000_000_000,
        };
      },
    },
  });
  proxies.push(proxy);
  const agentApiKey = `sk_agent_${"a".repeat(43)}`;
  const token = proxy.issue("agent-a", agentApiKey);
  const response = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.version.path),
    {
      method: agentApiRoutes.proxy.version.method,
      headers: { authorization: `Bearer ${token}` },
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    daemonVersion: "0.1.0-dev.38",
    computerVersion: "0.1.0-dev.38",
    daemonPid: 4242,
    startedAt: 1_726_000_000_000,
  });
  // No body is read for this GET route: the runtime request is an empty object, never
  // caller-supplied fields.
  expect(calls).toEqual([{ context: "agent-a", request: {}, agentApiKey }]);
});

test("proxy 404s coforge version when the runtime has no handler", async () => {
  const proxy = startAgentProxy({ runtime: { agentMessage: async () => ({}) } });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.version.path),
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(404);
});

test("proxy rejects unexpected GitHub credential fields before forwarding", async () => {
  let calls = 0;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      githubCredential: async () => {
        calls++;
        throw new Error("must not forward");
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.proxy.githubCredentials.path,
    ),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ repository: "Example-Org/private-repo" }),
    },
  );

  expect(response.status).toBe(400);
  expect(calls).toBe(0);
});

test("Agent API key remains usable after an idle day without refresh", async () => {
  let calls = 0;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        calls++;
        return {
          requestId: "request",
          accepted: true,
          attentionCount: 0,
          messages: [],
          messageId: "",
        };
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-idle", `sk_agent_${"a".repeat(43)}`);
  const request = () =>
    fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request", operation: "check" }),
    });

  expect((await request()).status).toBe(200);
  // The credential has no wall-clock expiry; this request represents the
  // first request after an arbitrarily long idle period.
  expect((await request()).status).toBe(200);
  expect(calls).toBe(2);
  proxy.revoke(token);
  expect((await request()).status).toBe(401);
});

test("rejects a message check operation that carries a target", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        throw new Error("check must not reach the runtime with a target");
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "request-1", operation: "check", target: "@ada" }),
  });
  expect(response.status).toBe(400);
});

test("proxy forwards validated range options with token-bound identity", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: () => "trusted-context",
      agentMessage: async (_context, request) => {
        calls.push(request);
        return {};
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);

  for (const options of [
    { before: "before-id", limit: 1 },
    { after: "after-id", limit: 100 },
    { around: "around-id", limit: 25 },
  ]) {
    const response = await fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: `request-${calls.length}`,
        operation: "read",
        target: "@alice",
        context: "caller-controlled",
        ...options,
      }),
    });
    expect(response.status).toBe(200);
  }

  expect(calls[0]).toMatchObject({
    requestId: "request-0",
    operation: "read",
    target: "@alice",
    before: "before-id",
    limit: 1,
    context: "trusted-context",
  });
  expect(calls[1]).toMatchObject({
    requestId: "request-1",
    operation: "read",
    target: "@alice",
    after: "after-id",
    limit: 100,
    context: "trusted-context",
  });
  expect(calls[2]).toMatchObject({
    requestId: "request-2",
    operation: "read",
    target: "@alice",
    around: "around-id",
    limit: 25,
    context: "trusted-context",
  });
});

test("proxy validates and forwards lexical search without accepting caller identity", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: () => "trusted-context",
      agentMessage: async (_context, request) => {
        calls.push(request);
        return { messages: [] };
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "search-1",
      operation: "search",
      query: "release",
      sender: "@ada",
      sort: "recent",
      after: "2026-09-01T00:00:00Z",
      before: "2026-09-07T00:00:00Z",
      limit: 10,
      offset: 2,
      context: "forged",
    }),
  });
  expect(response.status).toBe(200);
  expect(calls).toEqual([
    expect.objectContaining({
      requestId: "search-1",
      operation: "search",
      query: "release",
      sender: "@ada",
      sort: "recent",
      after: "2026-09-01T00:00:00Z",
      before: "2026-09-07T00:00:00Z",
      limit: 10,
      offset: 2,
      context: "trusted-context",
    }),
  ]);
  const invalid = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "search-2", operation: "search", sender: "not-a-handle" }),
  });
  expect(invalid.status).toBe(400);
  expect(calls).toHaveLength(1);
});

test("proxy rejects invalid range options before calling the runtime", async () => {
  let calls = 0;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        calls++;
        return {};
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const invalidOptions = [
    { before: "one", after: "two" },
    { before: 42 },
    { after: false },
    { around: null },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "10" },
  ];

  for (const options of invalidOptions) {
    const response = await fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        operation: "read",
        target: "@alice",
        ...options,
      }),
    });
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(0);
});

test("proxy forwards an authorized attachment download without exposing the Agent API key", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentAttachment: async (_context, attachmentId, apiKey) => {
        expect(attachmentId).toBe("attachment/1");
        expect(apiKey).toMatch(/^sk_agent_/);
        return new Response("file contents", {
          headers: { "content-type": "text/plain" },
        });
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.local.attachments.path("attachment/1"),
    ),
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("file contents");

  const legacyResponse = await fetch(`${proxy.url}/agent/attachment?attachmentId=attachment-1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(legacyResponse.status).toBe(404);
});

test("proxy forwards an authorized multipart attachment upload without exposing the Agent API key", async () => {
  const calls: Array<{
    context: string;
    apiKey: string;
    body: string;
    contentType: string | null;
  }> = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentAttachmentUpload: async (context, request, apiKey) => {
        calls.push({
          context,
          apiKey,
          body: await request.text(),
          contentType: request.headers.get("content-type"),
        });
        return Response.json({
          id: "attachment-1",
          fileName: "note.txt",
          contentType: "text/plain",
          sizeBytes: 4,
        });
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const boundary = "coforge-test-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="target"',
    "",
    "#general",
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="note.txt"',
    "Content-Type: text/plain",
    "",
    "body",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.local.attachments.upload.path,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(new TextEncoder().encode(body).byteLength),
      },
      body,
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: "attachment-1",
    fileName: "note.txt",
    contentType: "text/plain",
    sizeBytes: 4,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.apiKey).toMatch(/^sk_agent_/);
  expect(calls[0]?.contentType).toBe(`multipart/form-data; boundary=${boundary}`);
  expect(calls[0]?.body).toBe(body);
});

test("proxy rejects an attachment upload without a trustworthy content-length", async () => {
  let calls = 0;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentAttachmentUpload: async () => {
        calls++;
        throw new Error("must not forward an unbounded body");
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const uploadUrl = proxy.url.replace(
    agentApiRoutes.proxy.messages.path,
    agentApiRoutes.local.attachments.upload.path,
  );

  // A streamed body carries no known length, so `fetch` sends it chunked without a
  // content-length header at all (verified against `Bun.serve` directly).
  const chunkedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const missingLength = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "multipart/form-data; boundary=b",
    },
    body: chunkedBody,
    duplex: "half",
  });
  expect(missingLength.status).toBe(413);

  // `fetch` recomputes content-length from the real body, so the cap is exercised with a
  // genuinely oversized body rather than a spoofed header (`fetch` ignores the latter).
  const oversizedBody = new Uint8Array(10 * 1024 * 1024 + 64 * 1024 + 1);
  const overCap = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "multipart/form-data; boundary=b",
    },
    body: oversizedBody,
  });
  expect(overCap.status).toBe(413);
  expect(calls).toBe(0);
});

test("proxy forwards the direct-upload session create route as plain JSON", async () => {
  const calls: Array<{ context: string; body: unknown; apiKey: string }> = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentAttachmentUploadSessionCreate: async (context, body, apiKey) => {
        calls.push({ context, body, apiKey });
        return Response.json(
          { uploadId: "upload-1", attachmentId: "attachment-1", state: "pending" },
          { status: 201 },
        );
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.local.attachmentUploadSessions.create.path,
    ),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        target: "#general",
        fileName: "note.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        clientRequestId: crypto.randomUUID(),
      }),
    },
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    uploadId: "upload-1",
    attachmentId: "attachment-1",
    state: "pending",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.apiKey).toMatch(/^sk_agent_/);
  expect((calls[0]?.body as { target?: string })?.target).toBe("#general");
});

test("proxy forwards the direct-upload session complete, cancel and get routes", async () => {
  const calls: string[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentAttachmentUploadSessionComplete: async (_context, uploadId) => {
        calls.push(`complete:${uploadId}`);
        return Response.json({ uploadId, state: "completed" });
      },
      agentAttachmentUploadSessionCancel: async (_context, uploadId) => {
        calls.push(`cancel:${uploadId}`);
        return Response.json({ uploadId, state: "canceled" });
      },
      agentAttachmentUploadSessionGet: async (_context, uploadId) => {
        calls.push(`get:${uploadId}`);
        return Response.json({ uploadId, state: "pending" });
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const sessionUrl = (suffix: string) =>
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      `${agentApiRoutes.local.attachmentUploadSessions.get.path("upload-1")}${suffix}`,
    );

  const completed = await fetch(sessionUrl("/complete"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({ uploadId: "upload-1", state: "completed" });

  const fetched = await fetch(sessionUrl(""), { headers: { authorization: `Bearer ${token}` } });
  expect(fetched.status).toBe(200);
  expect(await fetched.json()).toEqual({ uploadId: "upload-1", state: "pending" });

  const canceled = await fetch(sessionUrl(""), {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(canceled.status).toBe(200);
  expect(await canceled.json()).toEqual({ uploadId: "upload-1", state: "canceled" });

  expect(calls).toEqual(["complete:upload-1", "get:upload-1", "cancel:upload-1"]);
});

test("proxy answers 404 for the session routes when the runtime does not implement them", async () => {
  const proxy = startAgentProxy({ runtime: { agentMessage: async () => ({}) } });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const createResponse = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.local.attachmentUploadSessions.create.path,
    ),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  expect(createResponse.status).toBe(404);
  const getResponse = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.local.attachmentUploadSessions.get.path("upload-1"),
    ),
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(getResponse.status).toBe(404);
});

test("proxy forwards resolve and react without accepting caller identity", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: () => "trusted-context",
      agentMessage: async (_context, request) => {
        calls.push(request);
        return {};
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);

  const resolveResponse = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "resolve-1",
      operation: "resolve",
      messageId: "abcd1234",
      context: "forged",
    }),
  });
  expect(resolveResponse.status).toBe(200);

  const reactResponse = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "react-1",
      operation: "react",
      messageId: "abcd1234",
      emoji: "👍",
      context: "forged",
    }),
  });
  expect(reactResponse.status).toBe(200);

  const unreactResponse = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "unreact-1",
      operation: "unreact",
      messageId: "abcd1234",
      emoji: "👍",
    }),
  });
  expect(unreactResponse.status).toBe(200);

  expect(calls).toEqual([
    expect.objectContaining({
      requestId: "resolve-1",
      operation: "resolve",
      messageId: "abcd1234",
      context: "trusted-context",
    }),
    expect.objectContaining({
      requestId: "react-1",
      operation: "react",
      messageId: "abcd1234",
      emoji: "👍",
      context: "trusted-context",
    }),
    expect.objectContaining({
      requestId: "unreact-1",
      operation: "unreact",
      messageId: "abcd1234",
      emoji: "👍",
      context: "trusted-context",
    }),
  ]);
});

test("proxy rejects resolve and react requests with bad ids or emoji", async () => {
  let calls = 0;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        calls++;
        return {};
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);

  for (const body of [
    { requestId: "r-1", operation: "resolve" },
    { requestId: "r-2", operation: "resolve", messageId: "not-hex" },
    { requestId: "r-3", operation: "react", messageId: "abcd1234" },
    { requestId: "r-4", operation: "react", messageId: "abcd1234", emoji: "" },
    { requestId: "r-5", operation: "react", messageId: "abcd1234", emoji: "a b" },
    { requestId: "r-6", operation: "react", messageId: "abcd1234", emoji: "x".repeat(17) },
    { requestId: "r-7", operation: "unreact", messageId: "abcd1234" },
  ]) {
    const response = await fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(0);
});

test("proxy forwards weekly-report reads after validating the local command", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        throw new Error("message must not run");
      },
      agentWeeklyReport: async (_context, command) => {
        calls.push(command);
        return {
          protocolMajor: 1,
          requestId: "request",
          operation: "list",
          result: { reports: [], nextCursor: null },
        };
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.weeklyReports.path),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "list", limit: 2 }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    protocolMajor: 1,
    requestId: "request",
    operation: "list",
    result: { reports: [], nextCursor: null },
  });
  expect(calls).toEqual([{ operation: "list", limit: 2 }]);
});

test("a local precondition failure (missing API key, no held draft, ...) is a classified 400, not a bare 502", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        throw new AgentPreflightError(`No held draft for target: @ada`, "NO_HELD_DRAFT");
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "request-1",
      operation: "send",
      target: "@ada",
      sendDraft: true,
    }),
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as AgentProxyFailureBody;
  expect(body).toMatchObject({
    error: "No held draft for target: @ada",
    code: "NO_HELD_DRAFT",
    proxy: { failure_class: "local_precondition", cause_code: "NO_HELD_DRAFT" },
  });
});

test("every route forwards the token-bound context and Agent API key to its runtime handler", async () => {
  const calls: Record<string, { context: string; agentApiKey?: string }> = {};
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: (agentId) => agentId,
      agentMessage: async (context, _request, agentApiKey) => {
        calls.messages = { context, agentApiKey };
        return {};
      },
      agentAttachment: async (context, _attachmentId, agentApiKey) => {
        calls.attachmentDownload = { context, agentApiKey };
        return new Response("file contents", { headers: { "content-type": "text/plain" } });
      },
      agentAttachmentUpload: async (context, _request, agentApiKey) => {
        calls.attachmentUpload = { context, agentApiKey };
        return Response.json({ id: "attachment-1" });
      },
      agentAttachmentUploadSessionCreate: async (context, _body, agentApiKey) => {
        calls.sessionCreate = { context, agentApiKey };
        return Response.json({ uploadId: "upload-1" });
      },
      agentAttachmentUploadSessionComplete: async (context, _uploadId, agentApiKey) => {
        calls.sessionComplete = { context, agentApiKey };
        return Response.json({ uploadId: "upload-1", state: "completed" });
      },
      agentAttachmentUploadSessionGet: async (context, _uploadId, agentApiKey) => {
        calls.sessionGet = { context, agentApiKey };
        return Response.json({ uploadId: "upload-1", state: "pending" });
      },
      agentAttachmentUploadSessionCancel: async (context, _uploadId, agentApiKey) => {
        calls.sessionCancel = { context, agentApiKey };
        return Response.json({ uploadId: "upload-1", state: "canceled" });
      },
      reminder: async (context, _request, agentApiKey) => {
        calls.reminders = { context, agentApiKey };
        return {};
      },
      agentTask: async (context, _request, agentApiKey) => {
        calls.tasks = { context, agentApiKey };
        return {};
      },
      agentChannel: async (context, _request, agentApiKey) => {
        calls.channels = { context, agentApiKey };
        return {};
      },
      agentActionPrepare: async (context, _request, agentApiKey) => {
        calls.actionPrepare = { context, agentApiKey };
        return {} as never;
      },
      agentWeeklyReport: async (context, _request, agentApiKey) => {
        calls.weeklyReports = { context, agentApiKey };
        return {};
      },
      workspaceInfo: async (context, request, agentApiKey) => {
        calls.workspace = { context, agentApiKey };
        return { requestId: request.requestId, protocolMajor: 1 } as never;
      },
      githubCredential: async (context, _request, agentApiKey) => {
        calls.githubCredentials = { context, agentApiKey };
        return {} as never;
      },
      manualGet: async (context, _request, agentApiKey) => {
        calls.manualGet = { context, agentApiKey };
        return {} as never;
      },
      manualSearch: async (context, _request, agentApiKey) => {
        calls.manualSearch = { context, agentApiKey };
        return {} as never;
      },
      version: async (context, _request, agentApiKey) => {
        calls.version = { context, agentApiKey };
        return { ok: true, daemonVersion: "0.1.0-dev.38" };
      },
      inbox: async (context) => {
        calls.inbox = { context };
        return {};
      },
    },
  });
  proxies.push(proxy);
  const agentApiKey = `sk_agent_${"a".repeat(43)}`;
  const token = proxy.issue("agent-a", agentApiKey);
  const auth = { authorization: `Bearer ${token}` };
  const jsonAuth = { ...auth, "content-type": "application/json" };
  const at = (path: string) => proxy.url.replace(agentApiRoutes.proxy.messages.path, path);

  const responses = await Promise.all([
    fetch(proxy.url, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ requestId: "r-messages", operation: "check" }),
    }),
    fetch(at(agentApiRoutes.proxy.workspace.path), {
      method: agentApiRoutes.proxy.workspace.method,
      headers: auth,
    }),
    fetch(at(agentApiRoutes.local.attachments.path("attachment-1")), { headers: auth }),
    fetch(at(agentApiRoutes.local.attachments.upload.path), {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "multipart/form-data; boundary=b",
        "content-length": "1",
      },
      body: new Uint8Array([1]),
    }),
    fetch(at(agentApiRoutes.local.attachmentUploadSessions.create.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({}),
    }),
    fetch(`${at(agentApiRoutes.local.attachmentUploadSessions.get.path("upload-1"))}/complete`, {
      method: "POST",
      headers: auth,
    }),
    fetch(at(agentApiRoutes.local.attachmentUploadSessions.get.path("upload-1")), {
      headers: auth,
    }),
    fetch(at(agentApiRoutes.local.attachmentUploadSessions.get.path("upload-1")), {
      method: "DELETE",
      headers: auth,
    }),
    fetch(at(agentApiRoutes.proxy.reminders.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ requestId: "r-1", operation: "list" }),
    }),
    fetch(at(agentApiRoutes.proxy.tasks.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ requestId: "r-1", operation: "list", target: "#general" }),
    }),
    fetch(at(agentApiRoutes.proxy.channels.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ requestId: "r-1", operation: "info", target: "#general" }),
    }),
    fetch(at(agentApiRoutes.proxy.actionPrepare.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        target: "#general",
        action: { type: "channel:create", name: "general" },
      }),
    }),
    fetch(at(agentApiRoutes.proxy.weeklyReports.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ operation: "list" }),
    }),
    fetch(at(agentApiRoutes.proxy.githubCredentials.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({}),
    }),
    fetch(at(agentApiRoutes.proxy.inbox.path), {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ requestId: "r-1", operation: "check" }),
    }),
    fetch(`${at(agentApiRoutes.proxy.manual.get.path)}?topic=tasks&intent=i&reason=r`, {
      headers: auth,
    }),
    fetch(`${at(agentApiRoutes.proxy.manual.search.path)}?query=tasks&intent=i&reason=r`, {
      headers: auth,
    }),
    fetch(at(agentApiRoutes.proxy.version.path), {
      method: agentApiRoutes.proxy.version.method,
      headers: auth,
    }),
  ]);
  for (const response of responses) expect(response.status).toBeLessThan(300);

  const withKey = [
    "messages",
    "workspace",
    "attachmentDownload",
    "attachmentUpload",
    "sessionCreate",
    "sessionComplete",
    "sessionGet",
    "sessionCancel",
    "reminders",
    "tasks",
    "channels",
    "actionPrepare",
    "weeklyReports",
    "githubCredentials",
    "manualGet",
    "manualSearch",
    "version",
  ];
  for (const route of withKey)
    expect(calls[route], `route: ${route}`).toEqual({ context: "agent-a", agentApiKey });
  // `inbox` takes no Agent API key; it must receive only the token-bound context.
  expect(calls.inbox).toEqual({ context: "agent-a" });
});

test("proxy 404s an attachment download when the runtime has no handler", async () => {
  const proxy = startAgentProxy({ runtime: { agentMessage: async () => ({}) } });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.local.attachments.path("attachment-1"),
    ),
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("not found");
});

test("a runtime SyntaxError is classified, not treated as a bare body-parsing 400", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        throw new SyntaxError("x");
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "request-1", operation: "check" }),
  });
  expect(response.status).toBe(502);
  const body = (await response.json()) as AgentProxyFailureBody;
  expect(body.code).toBe("agent_proxy_failed");
});

test("the incident: an upstream 200 whose body cannot be trusted is a protocol-mismatch failure, not a bare 502", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        // What dev.30's daemon actually received from a #264-shaped server: HTTP 200, but a body
        // this daemon build cannot decode/validate (see `daemon-connection.ts`'s strict `state`
        // check). The daemon must never let this reach the CLI as an unlabeled crash.
        throw AgentTransportError.protocolMismatch(
          "agent send",
          200,
          'response state is not one of "sent"/"held"/"denied" (got undefined)',
        );
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "request-1", operation: "send", target: "@ada", body: "hi" }),
  });
  expect(response.status).toBe(502);
  expect(response.headers.get("x-coforge-correlation-id")).toBeTruthy();
  const body = (await response.json()) as AgentProxyFailureBody;
  expect(body.proxy.failure_class).toBe("protocol_mismatch");
  expect(body.proxy.upstream_status).toBe(200);
  expect(body.proxy.response_started).toBe(true);
  expect(body.proxy.response_complete).toBe(true);
  expect(body.proxy.route_family).toBe("agent-api/send");
  expect(body.detail).toContain("response state is not one of");
});

test("an unknown method under the upload-session prefix is 404 before the token is checked", async () => {
  const proxy = startAgentProxy({
    runtime: { issueAgentContext: (agentId) => agentId, agentMessage: async () => ({}) },
  });
  proxies.push(proxy);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.local.attachmentUploadSessions.get.path("upload-1"),
    ),
    { method: "PUT" },
  );
  expect(response.status).toBe(404);
});

test("a GitHub credential failure is classified under its own route family", async () => {
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: (agentId) => agentId,
      agentMessage: async () => ({}),
      githubCredential: async () => {
        throw new Error("GitHub credential endpoint is not configured");
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.proxy.githubCredentials.path,
    ),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  expect(response.status).toBe(502);
  const body = (await response.json()) as { code: string; proxy: { route_family: string } };
  expect(body.code).toBe("agent_proxy_failed");
  expect(body.proxy.route_family).toBe("agent-api/github-credential");
});
