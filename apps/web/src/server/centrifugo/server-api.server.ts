import { AGENT_START_METHOD } from "@coforge/protocol";

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
        headers: { authorization: `apikey ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          method: "publish",
          params: { channel, data: btoa(binary) },
        }),
      });
      if (!response.ok) throw new Error(`Centrifugo publish failed (${response.status})`);
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
