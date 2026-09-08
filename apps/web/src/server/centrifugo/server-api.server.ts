import {
  AGENT_START_METHOD,
  encodeDaemonRuntimeUsageScanRequest,
  type RuntimeProvider,
} from "@coforge/protocol";
import { getUsageCache, type UsageCache } from "./usage-cache.server";

export type CentrifugoServerApi = {
  publish(channel: string, data: Uint8Array): Promise<void>;
  publishJson(channel: string, data: unknown, idempotencyKey?: string): Promise<void>;
};

/** Server-only adapter for Centrifugo's HTTP server API. Business code never builds its HTTP body. */
export function createCentrifugoServerApi(env = process.env): CentrifugoServerApi {
  const endpoint = env.COFORGE_CENTRIFUGO_API_URL;
  const apiKey = env.COFORGE_CENTRIFUGO_API_KEY;
  if (!endpoint || !apiKey) throw new Error("Centrifugo server API is not configured");
  const serverApiUrl = endpoint;
  const serverApiKey = apiKey;
  async function publish(params: Record<string, unknown>) {
    const response = await fetch(serverApiUrl, {
      method: "POST",
      headers: {
        "x-api-key": serverApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "publish", params }),
    });
    if (!response.ok) throw new Error(`Centrifugo publish failed (${response.status})`);
    const result = (await response.json()) as { error?: { code?: unknown } };
    if (result.error)
      throw new Error(
        `Centrifugo publish failed (${typeof result.error.code === "number" ? result.error.code : "command error"})`,
      );
  }
  return {
    async publish(channel, data) {
      let binary = "";
      for (const byte of data) binary += String.fromCharCode(byte);
      await publish({ channel, b64data: btoa(binary) });
    },
    async publishJson(channel, data, idempotencyKey) {
      await publish({
        channel,
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
    await cache.put({ ...input, scanId: requestId, status: "pending" });
    await api.publish(
      daemonControlChannel(input.workspaceId, input.computerId),
      encodeDaemonRuntimeUsageScanRequest({ protocolMajor: 1, requestId, ...input }),
    );
    return requestId;
  })();
}
