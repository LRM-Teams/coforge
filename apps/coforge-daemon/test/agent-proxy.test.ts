import { afterEach, expect, test } from "bun:test";
import { startAgentProxy } from "../src/agent-proxy";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
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

test("proxy forwards an authorized attachment download without exposing the Agent API key", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentAttachment: async (_context, attachmentId, apiKey) => {
        expect(attachmentId).toBe("attachment-1");
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
    `${proxy.url.replace("/agent/message", "/agent/attachment")}\u003fattachmentId=attachment-1`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("file contents");
});
