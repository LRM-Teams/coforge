import { afterEach, expect, test } from "bun:test";

import { createCentrifugoServerApi } from "../src/server/centrifugo/server-api.server";

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
