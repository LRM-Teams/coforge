import { expect, test } from "bun:test";
import type { RequestDetails } from "web-push";

import {
  resolvePinnedWebPushTarget,
  sendPinnedWebPushRequest,
  type FetchWebPushRequest,
  type PinnedWebPushTarget,
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
      resolvePinnedWebPushTarget("https://push.example/subscription", async () => [address]),
    ).rejects.toThrow("Web Push endpoint must resolve only to public addresses");
  }
});

test("pins a public Web Push endpoint to the validated DNS result", async () => {
  const target = await resolvePinnedWebPushTarget("https://push.example/subscription", async () => [
    { address: "203.0.114.8", family: 4 },
  ]);

  expect(target).toEqual({ hostname: "push.example", address: "203.0.114.8", family: 4 });
});

test("pins a public IPv6 Web Push endpoint to the validated DNS result", async () => {
  const target = await resolvePinnedWebPushTarget("https://push.example/subscription", async () => [
    { address: "2606:4700:4700::1111", family: 6 },
  ]);

  expect(target).toEqual({
    hostname: "push.example",
    address: "2606:4700:4700::1111",
    family: 6,
  });
});

test("rejects a DNS answer containing both public and private addresses", async () => {
  await expect(
    resolvePinnedWebPushTarget("https://push.example/subscription", async () => [
      { address: "203.0.114.8", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]),
  ).rejects.toThrow("Web Push endpoint must resolve only to public addresses");
});

function requestDetails(overrides: Partial<RequestDetails> = {}): RequestDetails {
  return {
    method: "POST",
    headers: { TTL: "60", "Content-Length": "5" },
    body: Buffer.from("hello"),
    endpoint: "https://push.example:8443/subscription?id=abc",
    ...overrides,
  };
}

test("sends the pinned request to the validated IPv4 address, preserving the original hostname", async () => {
  const target: PinnedWebPushTarget = {
    hostname: "push.example",
    address: "203.0.114.8",
    family: 4,
  };
  let seenUrl: string | undefined;
  let seenInit: RequestInit | undefined;
  const fetchImpl: FetchWebPushRequest = async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(null, { status: 201 });
  };

  const response = await sendPinnedWebPushRequest(requestDetails(), target, 5_000, fetchImpl);

  expect(response).toEqual({ statusCode: 201 });
  expect(seenUrl).toBe("https://203.0.114.8:8443/subscription?id=abc");
  expect(seenInit?.method).toBe("POST");
  expect((seenInit!.headers as Record<string, string>).TTL).toBe("60");
  expect((seenInit!.headers as Record<string, string>).Host).toBe("push.example:8443");
  expect(seenInit?.body).toEqual(Buffer.from("hello"));
  expect(seenInit?.redirect).toBe("manual");
  expect((seenInit as { keepalive?: boolean }).keepalive).toBe(false);
  expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  expect((seenInit as { tls?: { serverName?: string } }).tls?.serverName).toBe("push.example");
});

test("brackets a pinned IPv6 address in the request URL", async () => {
  const target: PinnedWebPushTarget = {
    hostname: "push.example",
    address: "2606:4700:4700::1111",
    family: 6,
  };
  let seenUrl: string | undefined;
  const fetchImpl: FetchWebPushRequest = async (url) => {
    seenUrl = String(url);
    return new Response(null, { status: 201 });
  };

  await sendPinnedWebPushRequest(
    requestDetails({ endpoint: "https://push.example/subscription?id=abc" }),
    target,
    5_000,
    fetchImpl,
  );

  expect(seenUrl).toBe("https://[2606:4700:4700::1111]/subscription?id=abc");
});

test("omits the port from the Host header when the endpoint has none", async () => {
  const target: PinnedWebPushTarget = {
    hostname: "push.example",
    address: "203.0.114.8",
    family: 4,
  };
  let seenInit: RequestInit | undefined;
  const fetchImpl: FetchWebPushRequest = async (_url, init) => {
    seenInit = init;
    return new Response(null, { status: 201 });
  };

  await sendPinnedWebPushRequest(
    requestDetails({ endpoint: "https://push.example/subscription?id=abc" }),
    target,
    5_000,
    fetchImpl,
  );

  expect((seenInit!.headers as Record<string, string>).Host).toBe("push.example");
});

test("rejects when the endpoint hostname changed after validation", async () => {
  const target: PinnedWebPushTarget = {
    hostname: "push.example",
    address: "203.0.114.8",
    family: 4,
  };
  const fetchImpl: FetchWebPushRequest = async () => new Response(null, { status: 201 });

  await expect(
    sendPinnedWebPushRequest(
      requestDetails({ endpoint: "https://other.example/subscription" }),
      target,
      5_000,
      fetchImpl,
    ),
  ).rejects.toThrow("Web Push hostname changed after validation");
});

test("aborts a hung connect once the deadline elapses instead of hanging", async () => {
  // Accepts the TCP connection but never answers, so the TLS handshake never completes:
  // the same "hung connect" shape a blackholed push endpoint produces.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {} },
  });
  // 127.0.0.1 is itself blocked by resolvePinnedWebPushTarget's validation, so this
  // target is constructed by hand rather than going through resolution.
  const target: PinnedWebPushTarget = { hostname: "push.example", address: "127.0.0.1", family: 4 };
  const details: RequestDetails = {
    method: "POST",
    headers: { TTL: "60" },
    body: null,
    endpoint: `https://push.example:${server.port}/subscription`,
  };

  try {
    const startedAt = Date.now();
    const error: unknown = await sendPinnedWebPushRequest(details, target, 200).catch(
      (caught: unknown) => caught,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
  } finally {
    server.stop(true);
  }
});
