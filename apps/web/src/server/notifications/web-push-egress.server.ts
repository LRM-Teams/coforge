// oxlint-disable-next-line no-restricted-imports -- web-push requires an HTTPS Agent to pin a validated DNS result, and this module issues the request through that pinned Agent to enforce a real deadline (Bun 1.4's `timeout` option never bounds the TCP connect phase: https://github.com/oven-sh/bun/issues/41133).
import { Agent, request } from "node:https";
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

export async function createWebPushEgressAgent(
  endpoint: string,
  resolve: ResolveAddresses = resolveAddresses,
) {
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
  return new Agent({
    keepAlive: false,
    lookup(requestedHostname, options, callback) {
      if (requestedHostname !== hostname) {
        callback(new Error("Web Push hostname changed after validation"), options.all ? [] : "");
        return;
      }
      if (options.all) callback(null, [selected]);
      else callback(null, selected.address, selected.family);
    },
  });
}

export type PinnedHttpsResponse = { statusCode: number; body: string };

/**
 * Sends a Web Push request through the given pinned, SSRF-guarded Agent and
 * enforces `timeoutMs` as a real per-request deadline via AbortSignal, since
 * Bun 1.4's `timeout` request option is inert against a hung TCP connect
 * (https://github.com/oven-sh/bun/issues/41133). Resolves with the response
 * status/body for any status code; rejects with the underlying network or
 * abort error on failure. The response body is always drained.
 */
export function sendPinnedHttpsRequest(
  agent: Agent,
  requestDetails: RequestDetails,
  timeoutMs: number,
): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(requestDetails.endpoint);
    let settled = false;

    const pushRequest = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: requestDetails.method,
        headers: requestDetails.headers,
        agent,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk;
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: response.statusCode ?? 0, body });
        });
        response.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      },
    );

    pushRequest.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    if (requestDetails.body) pushRequest.write(requestDetails.body);
    pushRequest.end();
  });
}
