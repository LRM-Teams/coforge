import { describe, expect, test } from "bun:test";
import { MEMORY_OPERATION_KEY_PATTERN } from "@lrm/coforge-sdk/agent";
import { memoryExplorerTools } from "../src/runner";

/**
 * The fenced Memory Agent profile's native tools (ADR 0054-D): every tool is a
 * plain proxy call — no shell, no filesystem — so the test surface is the
 * request shape and the error paths against a stubbed local proxy.
 */

const ENV = {
  // Carries the proxy's real base-path convention (the messages route — see
  // `connectLocal`): every tool must REPLACE the pathname, never append to it.
  COFORGE_AGENT_PROXY_URL: "http://127.0.0.1:8799/api/agent/v1/messages",
  COFORGE_AGENT_CONTEXT: "sfp_" + "a".repeat(43),
};

function withStubProxy(
  handler: (
    path: string,
    body: Record<string, unknown>,
    headers: Headers,
  ) => Response | Promise<Response>,
) {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = JSON.parse(String(request.body ? await request.text() : "{}"));
    calls.push({
      path: new URL(request.url).pathname,
      body,
      auth: request.headers.get("authorization"),
    });
    return handler(new URL(request.url).pathname, body, request.headers);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("memory explorer tools", () => {
  test("memory_start posts the start command with the proxy bearer context", async () => {
    const stub = withStubProxy(() =>
      Response.json({
        ok: true,
        sessionId: "s1",
        state: "active",
        items: [],
        remainingSteps: 4,
        duplicate: false,
      }),
    );
    try {
      const tools = memoryExplorerTools(ENV);
      const start = tools.find((tool) => tool.name === "memory_start")!;
      const result = await start.execute(
        "call-1",
        {
          start_key: "start-1",
          query: "how do we deploy",
          max_steps: 2,
        } as never,
        undefined,
        undefined,
        {} as never,
      );
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(stub.calls).toEqual([
        {
          path: "/api/agent/v1/memory",
          body: { op: "start", startKey: "start-1", query: "how do we deploy", maxSteps: 2 },
          auth: `Bearer ${ENV.COFORGE_AGENT_CONTEXT}`,
        },
      ]);
    } finally {
      stub.restore();
    }
  });

  test("memory_submit omits empty summary and missing citations", async () => {
    const stub = withStubProxy(() =>
      Response.json({
        ok: true,
        sessionId: "s1",
        state: "closed",
        found: true,
        summary: null,
        citations: [],
        duplicate: false,
      }),
    );
    try {
      const tools = memoryExplorerTools(ENV);
      const submit = tools.find((tool) => tool.name === "memory_submit")!;
      await submit.execute(
        "call-2",
        {
          session_id: "s1",
          operation_id: "close-1",
          found: true,
          summary: "   ",
        } as never,
        undefined,
        undefined,
        {} as never,
      );
      expect(stub.calls[0]?.body).toEqual({
        op: "close",
        sessionId: "s1",
        operationId: "close-1",
        found: true,
      });
    } finally {
      stub.restore();
    }
  });

  test("memory_offer posts the offer operation with targets and explicit-ask flag", async () => {
    const stub = withStubProxy(() => Response.json({ ok: true, published: true }));
    try {
      const tools = memoryExplorerTools(ENV);
      const offer = tools.find((tool) => tool.name === "memory_offer")!;
      const result = await offer.execute(
        "t1",
        {
          operation_key: "offer-1",
          conversation_id: "conv-1",
          target_agent_id: "agent-7",
          targets: [
            { kind: "insight", id: "11111111-1111-4111-8111-111111111111" },
            { kind: "skill", id: "22222222-2222-4222-8222-222222222222" },
          ],
          body: "@worker the team learned this",
          explicit_ask: true,
        },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(stub.calls).toEqual([
        {
          path: "/api/agent/v1/memory",
          body: {
            op: "offer",
            operationKey: "offer-1",
            conversationId: "conv-1",
            targetAgentId: "agent-7",
            targets: [
              { kind: "insight", id: "11111111-1111-4111-8111-111111111111" },
              { kind: "skill", id: "22222222-2222-4222-8222-222222222222" },
            ],
            body: "@worker the team learned this",
            explicitAsk: true,
          },
          auth: `Bearer ${ENV.COFORGE_AGENT_CONTEXT}`,
        },
      ]);
    } finally {
      stub.restore();
    }
  });

  test("send_channel_message posts the send operation to the messages route", async () => {
    const stub = withStubProxy(() => Response.json({ ok: true }));
    try {
      const tools = memoryExplorerTools(ENV);
      const send = tools.find((tool) => tool.name === "send_channel_message")!;
      await send.execute(
        "call-3",
        {
          request_id: "req-1",
          target: "#general",
          body: "team memory has a relevant lesson here",
        } as never,
        undefined,
        undefined,
        {} as never,
      );
      expect(stub.calls[0]?.path).toBe("/api/agent/v1/messages");
      expect(stub.calls[0]?.body).toEqual({
        requestId: "req-1",
        operation: "send",
        target: "#general",
        content: "team memory has a relevant lesson here",
      });
    } finally {
      stub.restore();
    }
  });

  test("message_check posts the check operation without a target", async () => {
    const stub = withStubProxy(() => Response.json({ targets: [] }));
    try {
      const tools = memoryExplorerTools(ENV);
      const check = tools.find((tool) => tool.name === "message_check")!;
      await check.execute("call-5", {} as never, undefined, undefined, {} as never);
      expect(stub.calls[0]?.path).toBe("/api/agent/v1/messages");
      expect(stub.calls[0]?.body?.operation).toBe("check");
      expect(stub.calls[0]?.body?.target).toBeUndefined();
    } finally {
      stub.restore();
    }
  });

  test("message_read posts the read operation for one target", async () => {
    const stub = withStubProxy(() => Response.json({ messages: [] }));
    try {
      const tools = memoryExplorerTools(ENV);
      const read = tools.find((tool) => tool.name === "message_read")!;
      await read.execute(
        "call-6",
        { request_id: "req-2", target: "#general" } as never,
        undefined,
        undefined,
        {} as never,
      );
      expect(stub.calls[0]?.path).toBe("/api/agent/v1/messages");
      expect(stub.calls[0]?.body).toEqual({
        requestId: "req-2",
        operation: "read",
        target: "#general",
      });
    } finally {
      stub.restore();
    }
  });

  test("a non-ok proxy response surfaces the status and body as an error", async () => {
    const stub = withStubProxy(
      () =>
        new Response(JSON.stringify({ ok: false, errorCode: "gm-memory-explorer-only" }), {
          status: 403,
        }),
    );
    try {
      const tools = memoryExplorerTools(ENV);
      const start = tools.find((tool) => tool.name === "memory_start")!;
      await expect(
        start.execute(
          "call-4",
          { start_key: "k", query: "q" } as never,
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("HTTP 403");
    } finally {
      stub.restore();
    }
  });

  test("the profile has exactly the eight native tools and no others", () => {
    expect(
      memoryExplorerTools(ENV)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "memory_explore",
      "memory_offer",
      "memory_redirect",
      "memory_start",
      "memory_submit",
      "message_check",
      "message_read",
      "send_channel_message",
    ]);
  });

  test("operation-key parameters carry the server's operation-key pattern", () => {
    // The web boundary rejects a startKey/operationId/operationKey that does
    // not match OPERATION_KEY with 400 gm-memory-request-invalid — the fenced
    // agent's schema must fence the same format before the LLM ever sends it
    // (live-convicted: the model naturally writes "closing work items"
    // phrases when the schema stays silent about the format).
    const parameters = (tool: string) =>
      (
        memoryExplorerTools(ENV).find((entry) => entry.name === tool)!.parameters as unknown as {
          properties: Record<string, { pattern?: string }>;
        }
      ).properties;
    expect(parameters("memory_start").start_key.pattern).toBe(MEMORY_OPERATION_KEY_PATTERN);
    expect(parameters("memory_explore").operation_id.pattern).toBe(MEMORY_OPERATION_KEY_PATTERN);
    expect(parameters("memory_redirect").operation_id.pattern).toBe(MEMORY_OPERATION_KEY_PATTERN);
    expect(parameters("memory_submit").operation_id.pattern).toBe(MEMORY_OPERATION_KEY_PATTERN);
    expect(parameters("memory_offer").operation_key.pattern).toBe(MEMORY_OPERATION_KEY_PATTERN);
  });
});
