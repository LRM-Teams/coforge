import { decodeAgentMessageResponse } from "@coforge/protocol";
export function connectLocal(
  _socketPath: string,
  context: string,
  proxyUrl = Bun.env.COFORGE_AGENT_PROXY_URL ?? "",
) {
  const call = async (operation: "check" | "read" | "send", target?: string, body?: string) => {
    if (!context) throw new Error("coforge agent context is not configured");
    if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    const requestId = crypto.randomUUID();
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    let response: Response;
    try {
      response = await fetch(proxyUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify({ requestId, operation, target, body }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("agent proxy request failed (network or timeout)");
    }
    if (!response.ok) throw new Error(`agent proxy request failed (${response.status})`);
    return (await response.json()) as ReturnType<typeof decodeAgentMessageResponse>;
  };
  return {
    check: (target?: string) => call("check", target),
    read: (target?: string) => call("read", target),
    send: (target?: string, body?: string) => call("send", target, body),
  };
}
