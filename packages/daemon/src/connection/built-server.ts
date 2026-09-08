const DEFAULT_PRODUCTION_SERVER_URL = "https://coforge.cn";

export const COFORGE_DAEMON_SERVER_URL =
  process.env.COFORGE_DAEMON_SERVER_URL || DEFAULT_PRODUCTION_SERVER_URL;

export function daemonConnectionEndpoint(serverUrl: string): string {
  const endpoint = new URL("/connection/websocket", serverUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint.href;
}
