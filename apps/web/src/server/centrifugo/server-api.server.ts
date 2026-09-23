import {
  AGENT_START_METHOD,
  encodeAgentContextScanRequest,
  encodeDaemonRuntimeUsageScanRequest,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { getUsageCache, type UsageCache } from "./usage-cache.server";
import { getAgentContextCache, type AgentContextCache } from "./agent-context-cache.server";

export type CentrifugoServerApi = {
  publish(channel: string, data: Uint8Array): Promise<void>;
  publishJson(channel: string, data: unknown, idempotencyKey?: string): Promise<void>;
  /** One Centrifugo `broadcast` call to many channels at once, instead of N sequential `publish`
   * calls (https://centrifugal.dev/docs/server/server_api#broadcast). A no-op when `channels` is
   * empty. `idempotencyKey` acts per channel, matching `publishJson`'s per-channel semantics. */
  broadcast(channels: string[], data: unknown, idempotencyKey?: string): Promise<void>;
};

/** How long one Centrifugo server-API call may take, connect included, before it is aborted. */
const CENTRIFUGO_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Server-only adapter for Centrifugo's HTTP server API. Business code never builds its HTTP body.
 * Every call carries a deadline, so an unreachable Centrifugo rejects (`TimeoutError`) instead of
 * holding the request that published.
 */
export function createCentrifugoServerApi(
  env = process.env,
  { timeoutMs = CENTRIFUGO_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
): CentrifugoServerApi {
  const endpoint = env.COFORGE_CENTRIFUGO_API_URL;
  const apiKey = env.COFORGE_CENTRIFUGO_API_KEY;
  if (!endpoint || !apiKey) throw new Error("Centrifugo server API is not configured");
  const serverApiUrl = endpoint;
  const serverApiKey = apiKey;
  async function call(method: string, params: Record<string, unknown>) {
    const response = await fetch(serverApiUrl, {
      method: "POST",
      headers: {
        "x-api-key": serverApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Centrifugo ${method} failed (${response.status})`);
    const result = (await response.json()) as {
      error?: { code?: unknown };
      result?: { responses?: Array<{ error?: { code?: unknown } }> };
    };
    if (result.error)
      throw new Error(
        `Centrifugo ${method} failed (${typeof result.error.code === "number" ? result.error.code : "command error"})`,
      );
    const failed = result.result?.responses?.find((response) => response.error);
    if (failed)
      throw new Error(
        `Centrifugo ${method} failed (${typeof failed.error?.code === "number" ? failed.error.code : "command error"})`,
      );
  }
  return {
    async publish(channel, data) {
      let binary = "";
      for (const byte of data) binary += String.fromCharCode(byte);
      await call("publish", { channel, b64data: btoa(binary) });
    },
    async publishJson(channel, data, idempotencyKey) {
      await call("publish", {
        channel,
        data,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
    },
    async broadcast(channels, data, idempotencyKey) {
      if (channels.length === 0) return;
      await call("broadcast", {
        channels,
        data,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
    },
  };
}

/** A private control channel for one authenticated Workspace–Computer connection. */
export const daemonControlChannel = (workspaceId: string, computerId: string) =>
  `daemon:${workspaceId}:${computerId}`;
export { AGENT_START_METHOD };
export function createUsageScan(
  api: Pick<CentrifugoServerApi, "publish">,
  input: { workspaceId: string; computerId: string; provider: RuntimeProvider },
  cache: UsageCache = getUsageCache(),
): Promise<string> {
  const requestId = crypto.randomUUID();
  return (async () => {
    await cache.putScan({ ...input, scanId: requestId, status: "pending" });
    await api.publish(
      daemonControlChannel(input.workspaceId, input.computerId),
      encodeDaemonRuntimeUsageScanRequest({ protocolMajor: 1, requestId, ...input }),
    );
    return requestId;
  })();
}

/** Server → daemon context-composition scan: one Agent, its own launch/session echoed
 * for correlation only — the daemon still resolves its own current launch/session before running
 * anything. The launch/session the server fills in come from its own record of the Agent's
 * current control state, supplied by the caller. */
export function createAgentContextScan(
  api: Pick<CentrifugoServerApi, "publish">,
  input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    provider: RuntimeProvider;
    launchId: string;
    sessionId: string;
  },
  cache: AgentContextCache = getAgentContextCache(),
): Promise<string> {
  const requestId = crypto.randomUUID();
  return (async () => {
    await cache.putScan({ ...input, scanId: requestId, status: "pending" });
    await api.publish(
      daemonControlChannel(input.workspaceId, input.computerId),
      encodeAgentContextScanRequest({ protocolMajor: 1, requestId, ...input }),
    );
    return requestId;
  })();
}
