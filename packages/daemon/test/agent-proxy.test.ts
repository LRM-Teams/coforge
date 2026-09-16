import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "../src/agent-proxy";
import { AgentMessageRequestError } from "../src/connection/agent-message-request-error";
import { AgentTaskRequestError } from "../src/connection/agent-task-request-error";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

test("proxy returns safe Agent message failures and hides unknown failures", async () => {
  for (const [failure, status, message] of [
    [
      AgentMessageRequestError.fromRpc(400, "ambiguous message prefix; use the full UUID"),
      400,
      "ambiguous message prefix; use the full UUID",
    ],
    [
      AgentMessageRequestError.fromRpc(500, "database password leaked"),
      502,
      "proxy request failed",
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
    expect(await response.text()).toBe(message);
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
  expect([message.status, await message.text()]).toEqual([502, "proxy request failed"]);
  const task = await post(agentApiRoutes.proxy.tasks.path, {
    requestId: "task",
    operation: "claim",
    target: "#general",
    number: 1,
  });
  expect([task.status, await task.text()]).toEqual([502, "proxy request failed"]);
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
