import { Agent } from "node:https";

import { expect, test } from "bun:test";
import type { RequestDetails } from "web-push";

import {
  createWebPushEgressAgent,
  sendPinnedHttpsRequest,
} from "../src/server/notifications/web-push-egress.server";

test("rejects Web Push endpoints that resolve to non-public addresses", async () => {
  for (const address of [
    { address: "127.0.0.1", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "10.0.0.8", family: 4 as const },
    { address: "192.88.99.1", family: 4 as const },
    { address: "::1", family: 6 as const },
    { address: "100:0:0:1::1", family: 6 as const },
    { address: "64:ff9b:1::8", family: 6 as const },
    { address: "3fff::8", family: 6 as const },
    { address: "4000::8", family: 6 as const },
    { address: "5f00::8", family: 6 as const },
    { address: "8000::8", family: 6 as const },
    { address: "fec0::8", family: 6 as const },
    { address: "f000::8", family: 6 as const },
    { address: "fd00::8", family: 6 as const },
    { address: "fe80::8", family: 6 as const },
  ]) {
    await expect(
      createWebPushEgressAgent("https://push.example/subscription", async () => [address]),
    ).rejects.toThrow("Web Push endpoint must resolve only to public addresses");
  }
});

test("pins a public Web Push endpoint to the validated DNS result", async () => {
  const agent = await createWebPushEgressAgent("https://push.example/subscription", async () => [
    { address: "203.0.114.8", family: 4 },
  ]);
  const lookup = agent.options.lookup;
  if (!lookup) throw new Error("Expected a pinned DNS lookup");

  const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup("push.example", {}, (error, address, family) => {
      if (error) reject(error);
      else if (typeof address === "string") resolve({ address, family: family ?? 0 });
      else reject(new Error("Expected one pinned address"));
    });
  });

  expect(result).toEqual({ address: "203.0.114.8", family: 4 });
});

test("pins a public IPv6 Web Push endpoint to the validated DNS result", async () => {
  const agent = await createWebPushEgressAgent("https://push.example/subscription", async () => [
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const lookup = agent.options.lookup;
  if (!lookup) throw new Error("Expected a pinned DNS lookup");

  const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup("push.example", {}, (error, address, family) => {
      if (error) reject(error);
      else if (typeof address === "string") resolve({ address, family: family ?? 0 });
      else reject(new Error("Expected one pinned address"));
    });
  });

  expect(result).toEqual({ address: "2606:4700:4700::1111", family: 6 });
});

test("rejects a DNS answer containing both public and private addresses", async () => {
  await expect(
    createWebPushEgressAgent("https://push.example/subscription", async () => [
      { address: "203.0.114.8", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]),
  ).rejects.toThrow("Web Push endpoint must resolve only to public addresses");
});

test("aborts a hung connect once the deadline elapses instead of hanging", async () => {
  // Accepts the TCP connection but never answers, so the TLS handshake never completes:
  // the same "hung connect" shape a blackholed push endpoint produces.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {} },
  });
  const agent = new Agent({
    keepAlive: false,
    lookup(_hostname, options, callback) {
      if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    },
  });
  const requestDetails: RequestDetails = {
    method: "POST",
    headers: { TTL: "60" },
    body: null,
    endpoint: `https://push.example:${server.port}/subscription`,
  };

  try {
    const startedAt = Date.now();
    const error: unknown = await sendPinnedHttpsRequest(agent, requestDetails, 200).catch(
      (caught: unknown) => caught,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect((error as { statusCode?: unknown }).statusCode).toBeUndefined();
  } finally {
    server.stop(true);
  }
});
