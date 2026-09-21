// oxlint-disable-next-line no-restricted-imports -- BlockList provides audited IPv4 and IPv6 subnet matching for the egress boundary.
import { BlockList } from "node:net";

import type { RequestDetails } from "web-push";

type Address = { address: string; family: 4 | 6 };
type ResolveAddresses = (hostname: string) => Promise<readonly Address[]>;

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
const publicIpv6Addresses = new BlockList();

publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

async function resolveAddresses(hostname: string): Promise<readonly Address[]> {
  return Bun.dns.lookup(hostname, { backend: "system" });
}

export type PinnedWebPushTarget = { hostname: string; address: string; family: 4 | 6 };

/**
 * Resolves a Web Push endpoint's hostname and validates that every returned
 * address is public, rejecting loopback, link-local, private, and other
 * non-public ranges. Returns the hostname alongside one validated address to
 * pin the subsequent request to, preventing a DNS rebind between validation
 * and the request itself.
 */
export async function resolvePinnedWebPushTarget(
  endpoint: string,
  resolve: ResolveAddresses = resolveAddresses,
): Promise<PinnedWebPushTarget> {
  const hostname = new URL(endpoint).hostname;
  const addresses = await resolve(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      family === 4
        ? blockedIpv4Addresses.check(address, "ipv4")
        : !publicIpv6Addresses.check(address, "ipv6") ||
          blockedIpv6Addresses.check(address, "ipv6"),
    )
  ) {
    throw new Error("Web Push endpoint must resolve only to public addresses");
  }

  const selected = addresses[0]!;
  return { hostname, address: selected.address, family: selected.family };
}

export type PinnedWebPushResponse = { statusCode: number };

export type FetchWebPushRequest = (url: string, init: BunFetchRequestInit) => Promise<Response>;

/**
 * Sends a Web Push request pinned to the validated target address, bypassing
 * DNS resolution entirely so the request can never reach a different address
 * than the one `resolvePinnedWebPushTarget` validated. The TLS handshake is
 * still verified against the endpoint's real hostname via `tls.serverName`,
 * and the `Host` header preserves that hostname for the push service.
 * Redirects are never followed (`redirect: "manual"`): a redirect response is
 * treated as a non-2xx failure so the pinned connection can't be escaped.
 * `AbortSignal.timeout` enforces a real per-request deadline, including the
 * TCP connect and TLS handshake phases. `keepalive: false` disables Bun's
 * fetch connection pooling for this request, matching the prior `node:https`
 * Agent's `keepAlive: false` so a pinned connection is never reused across
 * different validated targets. The response body is always cancelled.
 */
export async function sendPinnedWebPushRequest(
  requestDetails: RequestDetails,
  target: PinnedWebPushTarget,
  timeoutMs: number,
  fetchImpl: FetchWebPushRequest = fetch,
): Promise<PinnedWebPushResponse> {
  const endpoint = new URL(requestDetails.endpoint);
  if (endpoint.hostname !== target.hostname) {
    throw new Error("Web Push hostname changed after validation");
  }

  const pinnedHost = target.family === 6 ? `[${target.address}]` : target.address;
  const url = `https://${pinnedHost}${endpoint.port ? `:${endpoint.port}` : ""}${endpoint.pathname}${endpoint.search}`;
  const hostHeader = endpoint.port ? `${target.hostname}:${endpoint.port}` : target.hostname;

  const response = await fetchImpl(url, {
    method: requestDetails.method,
    headers: { ...requestDetails.headers, Host: hostHeader },
    body: requestDetails.body ? new Uint8Array(requestDetails.body) : undefined,
    tls: { serverName: target.hostname },
    redirect: "manual",
    keepalive: false,
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  return { statusCode: response.status };
}
