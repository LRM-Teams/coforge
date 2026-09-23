import { afterEach, expect, test } from "bun:test";
import { decodeDaemonRuntimeUsageScanRequest } from "@lrm/coforge-sdk/internal";

import { createCentrifugoServerApi, createUsageScan } from "@/server/centrifugo/server-api.server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("publishes binary protocol payloads through the Centrifugo v6 HTTP API", async () => {
  let request: Request | undefined;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      request = new Request(input, init);
      return Promise.resolve(Response.json({ result: {} }));
    },
    { preconnect: originalFetch.preconnect },
  );

  await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publish("workspace:workspace-1", Uint8Array.of(0, 255, 42));

  expect(request?.headers.get("x-api-key")).toBe("test-api-key");
  expect(await request?.json()).toEqual({
    method: "publish",
    params: { channel: "workspace:workspace-1", b64data: "AP8q" },
  });
});

test("publishes an idempotent JSON chat event through the Centrifugo v6 HTTP API", async () => {
  let request: Request | undefined;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      request = new Request(input, init);
      return Promise.resolve(Response.json({ result: { offset: 7, epoch: "chat" } }));
    },
    { preconnect: originalFetch.preconnect },
  );

  await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishJson(
    "chat:12345678-0000-4000-8000-000000000001",
    {
      type: "message.available.v1",
      conversationId: "12345678-0000-4000-8000-000000000001",
      messageId: "12345678-0000-4000-8000-000000000002",
      sequence: 42,
    },
    "12345678-0000-4000-8000-000000000002",
  );

  expect(await request?.json()).toEqual({
    method: "publish",
    params: {
      channel: "chat:12345678-0000-4000-8000-000000000001",
      data: {
        type: "message.available.v1",
        conversationId: "12345678-0000-4000-8000-000000000001",
        messageId: "12345678-0000-4000-8000-000000000002",
        sequence: 42,
      },
      idempotency_key: "12345678-0000-4000-8000-000000000002",
    },
  });
});

test("broadcasts one JSON payload to many channels in a single Centrifugo call", async () => {
  let request: Request | undefined;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      request = new Request(input, init);
      return Promise.resolve(Response.json({ result: { responses: [{}, {}] } }));
    },
    { preconnect: originalFetch.preconnect },
  );

  await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).broadcast(
    ["chat:user:user-1", "chat:user:user-2"],
    { type: "notification.available.v1", messageId: "message-1", workspaceId: "workspace-1" },
    "notification:message-1",
  );

  expect(await request?.json()).toEqual({
    method: "broadcast",
    params: {
      channels: ["chat:user:user-1", "chat:user:user-2"],
      data: {
        type: "notification.available.v1",
        messageId: "message-1",
        workspaceId: "workspace-1",
      },
      idempotency_key: "notification:message-1",
    },
  });
});

test("skips the Centrifugo call entirely when a broadcast has no channels", async () => {
  let called = false;
  globalThis.fetch = Object.assign(
    () => {
      called = true;
      return Promise.resolve(Response.json({ result: {} }));
    },
    { preconnect: originalFetch.preconnect },
  );

  await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).broadcast([], { type: "notification.available.v1" });

  expect(called).toBe(false);
});

test("rejects when any individual channel in a broadcast fails", async () => {
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json({ result: { responses: [{}, { error: { code: 103, message: "denied" } }] } }),
      ),
    { preconnect: originalFetch.preconnect },
  );

  expect(
    createCentrifugoServerApi({
      COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
      COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
    }).broadcast(["chat:user:user-1", "chat:user:user-2"], { type: "notification.available.v1" }),
  ).rejects.toThrow("Centrifugo broadcast failed (103)");
});

test("rejects a Centrifugo command error returned with HTTP 200", async () => {
  globalThis.fetch = Object.assign(
    () => Promise.resolve(Response.json({ error: { code: 102, message: "unknown channel" } })),
    { preconnect: originalFetch.preconnect },
  );

  expect(
    createCentrifugoServerApi({
      COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
      COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
    }).publish("workspace:workspace-1", Uint8Array.of(1)),
  ).rejects.toThrow("Centrifugo publish failed (102)");
});

test("directs a runtime usage scan to the selected Computer's Daemon", async () => {
  let publication: { channel: string; data: Uint8Array } | undefined;
  await createUsageScan(
    {
      async publish(channel, data) {
        publication = { channel, data };
      },
    },
    { workspaceId: "workspace-1", computerId: "computer-1", provider: "codex" },
    {
      async putScan() {},
      async putResult() {},
      async read() {
        return { state: "missing" as const };
      },
    },
  );

  expect(publication?.channel).toBe("daemon:workspace-1:computer-1");
  expect(decodeDaemonRuntimeUsageScanRequest(publication!.data)).toMatchObject({
    workspaceId: "workspace-1",
    computerId: "computer-1",
    provider: "codex",
  });
});
