import {
  AGENT_START_METHOD,
  encodeDaemonRuntimeUsageScanRequest,
  type RuntimeProvider,
} from "@coforge/protocol";
import { getUsageCache, type UsageCache } from "./usage-cache.server";

export type CentrifugoServerApi = {
  publish(channel: string, data: Uint8Array): Promise<void>;
};

/** Server-only adapter for Centrifugo's HTTP server API. Business code never builds its HTTP body. */
export function createCentrifugoServerApi(env = process.env): CentrifugoServerApi {
  const endpoint = env.COFORGE_CENTRIFUGO_API_URL;
  const apiKey = env.COFORGE_CENTRIFUGO_API_KEY;
  if (!endpoint || !apiKey) throw new Error("Centrifugo server API is not configured");
  return {
    async publish(channel, data) {
      let binary = "";
      for (const byte of data) binary += String.fromCharCode(byte);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          method: "publish",
          params: { channel, b64data: btoa(binary) },
        }),
      });
      if (!response.ok) throw new Error(`Centrifugo publish failed (${response.status})`);
      const result = (await response.json()) as { error?: { code?: unknown } };
      if (result.error)
        throw new Error(
          `Centrifugo publish failed (${typeof result.error.code === "number" ? result.error.code : "command error"})`,
        );
    },
  };
}

/**
 * Workspace-scoped transport channel.  A daemon has one connection for its
 * configured Workspace, which may carry multiple Agents; Agent ids remain
 * payload/business data rather than connection identifiers.
 */
export const workspaceAgentChannel = (workspaceId: string) => `workspace:${workspaceId}`;
export { AGENT_START_METHOD };
export function createUsageScan(
  api: CentrifugoServerApi,
  input: { workspaceId: string; computerId: string; provider: RuntimeProvider },
  cache: UsageCache = getUsageCache(),
): Promise<string> {
  const requestId = crypto.randomUUID();
  return (async () => {
    await cache.put({ ...input, scanId: requestId, status: "pending" });
    await api.publish(
      workspaceAgentChannel(input.workspaceId),
      encodeDaemonRuntimeUsageScanRequest({ protocolMajor: 1, requestId, ...input }),
    );
    return requestId;
  })();
}
