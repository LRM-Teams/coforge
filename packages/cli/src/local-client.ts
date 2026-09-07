import { AGENT_MESSAGE_VALIDATION_MESSAGES, decodeAgentMessageResponse } from "@coforge/protocol";

const SAFE_AGENT_PROXY_VALIDATION_ERRORS = new Set<string>(AGENT_MESSAGE_VALIDATION_MESSAGES);

export function connectLocal(
  _socketPath: string,
  context: string,
  proxyUrl = Bun.env.COFORGE_AGENT_PROXY_URL ?? "",
) {
  const call = async (
    operation: "check" | "read" | "send" | "mute" | "unmute",
    target?: string,
    body?: string,
    options?: {
      sendDraft?: boolean;
      continueAnyway?: boolean;
      before?: string;
      after?: string;
      around?: string;
      limit?: number;
    },
  ) => {
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
        body: JSON.stringify({ requestId, operation, target, body, ...options }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("agent proxy request failed (network or timeout)");
    }
    if (!response.ok) {
      const detail = response.status === 400 ? await response.text() : undefined;
      if (detail && SAFE_AGENT_PROXY_VALIDATION_ERRORS.has(detail)) throw new Error(detail);
      throw new Error(`agent proxy request failed (${response.status})`);
    }
    return (await response.json()) as ReturnType<typeof decodeAgentMessageResponse>;
  };
  return {
    inboxCheck: () => callInbox(),
    setChannelMuted: (target: string, muted: boolean) => call(muted ? "mute" : "unmute", target),
    check: () => call("check"),
    read: (
      target: string,
      options?: { before?: string; after?: string; around?: string; limit?: number },
    ) => call("read", target, undefined, options),
    send: (
      target: string,
      body?: string,
      options?: { sendDraft?: boolean; continueAnyway?: boolean },
    ) => call("send", target, body, options),
    view: async (attachmentId: string) => {
      if (!context) throw new Error("coforge agent context is not configured");
      if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
        throw new Error("coforge agent context is invalid");
      if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
      const response = await fetch(
        `${proxyUrl.replace(/\/agent\/message$/, "/agent/attachment")}\u003fattachmentId=${encodeURIComponent(attachmentId)}`,
        { headers: { authorization: `Bearer ${context}` }, signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) throw new Error(`attachment download failed (${response.status})`);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        fileName: response.headers.get("content-disposition") ?? undefined,
      };
    },
  };

  async function callInbox() {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const response = await fetch(proxyUrl.replace(/\/agent\/message$/, "/agent/inbox"), {
      method: "POST",
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), operation: "check" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`agent inbox request failed (${response.status})`);
    return response.json();
  }
}
