import { expect, test } from "bun:test";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  sanitizeOpenVikingTransportFailure,
} from "./route-policy";
import { createOpenVikingRuntimeClient } from "./runtime-client.server";

const IDENTITY = {
  accountId: "acct-ws-a",
  userId: "user:u-1",
  role: "admin" as const,
  authorization: "Bearer server-held-key",
};

function headersFrom(init: RequestInit | undefined): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

test("runtime client normalizes the path and refuses encoded traversal without calling fetch", async () => {
  let called = false;
  const client = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933",
    fetchImpl: async () => {
      called = true;
      return new Response("ok");
    },
  });
  const denied = await client.request({
    method: "GET",
    path: "/api/v1/content/%2e%2e/admin/accounts",
    identity: IDENTITY,
  });
  expect(denied).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("invalid_path"),
  });
  expect(called).toBe(false);

  const escaped = await client.request({
    method: "GET",
    path: "http://evil.example/api/v1/content/read",
    identity: IDENTITY,
  });
  expect(escaped.ok).toBe(false);
  expect(called).toBe(false);
});

test("runtime client strips caller identity headers and injects the server-held OpenViking identity", async () => {
  let captured: { url: string; headers: Record<string, string> } | undefined;
  const client = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933/",
    fetchImpl: async (input, init) => {
      captured = { url: String(input), headers: headersFrom(init) };
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    },
  });
  const result = await client.request({
    method: "get",
    path: "/api/v1/content/read/",
    query: { uri: "viking://resources/doc.md" },
    headers: {
      Authorization: "Bearer attacker-key",
      "X-API-Key": "stolen-key",
      "X-OpenViking-Account": "acct-evil",
      "X-OpenViking-User": "root",
      "X-OpenViking-Role": "root",
      "X-OpenViking-Actor-Peer": "peer-user",
      "Content-Type": "application/json",
    },
    identity: IDENTITY,
  });
  expect(result.ok).toBe(true);
  expect(captured?.url).toBe(
    "http://ov.internal:1933/api/v1/content/read?uri=viking%3A%2F%2Fresources%2Fdoc.md",
  );
  expect(captured?.headers).toEqual({
    authorization: "Bearer server-held-key",
    "content-type": "application/json",
    "x-openviking-account": "acct-ws-a",
    "x-openviking-user": "user:u-1",
    "x-openviking-role": "admin",
  });
  if (result.ok) {
    expect(await new Response(result.response.body).text()).toBe("ok");
    expect(result.response.status).toBe(200);
  }
});

test("runtime client does not authorize Workspace scope or classify routes", async () => {
  let capturedPath = "";
  const client = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933",
    fetchImpl: async (input) => {
      capturedPath = new URL(String(input)).pathname;
      return new Response("{}", { status: 200 });
    },
  });
  const result = await client.request({
    method: "DELETE",
    path: "/api/v1/admin/accounts/acct-foreign",
    identity: IDENTITY,
  });
  expect(result.ok).toBe(true);
  expect(capturedPath).toBe("/api/v1/admin/accounts/acct-foreign");
});

test("request and response size limits fail closed before leaking bytes", async () => {
  let called = false;
  const client = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933",
    limits: { ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS, maxRequestBytes: 8, maxResponseBytes: 8 },
    fetchImpl: async () => {
      called = true;
      return new Response("0123456789", { headers: { "content-length": "10" } });
    },
  });
  const oversizedRequest = await client.request({
    method: "POST",
    path: "/api/v1/content/write",
    body: "012345678",
    identity: IDENTITY,
  });
  expect(oversizedRequest).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("request_too_large"),
  });
  expect(called).toBe(false);

  const oversizedResponse = await client.request({
    method: "GET",
    path: "/api/v1/content/read",
    identity: IDENTITY,
  });
  expect(oversizedResponse).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("response_too_large"),
  });
});

test("streamed responses pass through until the byte limit is exceeded", async () => {
  const client = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933",
    limits: { ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS, maxResponseBytes: 8 },
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("abcd"));
            controller.enqueue(new TextEncoder().encode("efgh"));
            controller.close();
          },
        }),
      ),
  });
  const result = await client.request({
    method: "GET",
    path: "/api/v1/content/download",
    identity: IDENTITY,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(await new Response(result.response.body).text()).toBe("abcdefgh");
  }

  const oversizeClient = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933",
    limits: { ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS, maxResponseBytes: 8 },
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("0123456789"));
            controller.close();
          },
        }),
      ),
  });
  const oversize = await oversizeClient.request({
    method: "GET",
    path: "/api/v1/content/download",
    identity: IDENTITY,
  });
  expect(oversize.ok).toBe(true);
  if (oversize.ok) {
    await expect(new Response(oversize.response.body).arrayBuffer()).rejects.toThrow(
      "OpenViking response exceeds the size limit",
    );
  }
});

test("timeouts abort the fetch and map to a sanitized timeout failure", async () => {
  const client = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933",
    limits: { ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS, timeoutMs: 20 },
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        });
      }),
  });
  const result = await client.request({
    method: "GET",
    path: "/health",
    identity: IDENTITY,
  });
  expect(result).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("timeout"),
  });
});

test("transport failures are sanitized and never echo OpenViking internals or credentials", async () => {
  const client = createOpenVikingRuntimeClient({
    baseUrl: "http://ov.internal:1933",
    fetchImpl: async () => {
      throw new Error(
        "connect ECONNREFUSED 10.1.2.3:1933 Authorization: Bearer ov-root-key /var/lib/openviking",
      );
    },
  });
  const result = await client.request({
    method: "GET",
    path: "/ready",
    identity: IDENTITY,
  });
  expect(result).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("runtime_unavailable"),
  });
  expect(JSON.stringify(result)).not.toContain("10.1.2.3");
  expect(JSON.stringify(result)).not.toContain("ov-root-key");
  expect(JSON.stringify(result)).not.toContain("/var/lib/openviking");
});
