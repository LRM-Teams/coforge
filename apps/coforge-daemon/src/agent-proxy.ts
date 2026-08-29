import { randomBytes } from "node:crypto";

export type AgentProxy = {
  url: string;
  issue(agentId: string, agentApiKey: string): string;
  revoke(token: string): void;
  close(): void;
};

const LOCAL_PROXY_TOKEN = /^sfp_[A-Za-z0-9_-]{43}$/;
const AGENT_API_KEY = /^sk_agent_[A-Za-z0-9_-]{43}$/;

/** One daemon-local HTTP boundary shared by all Agent child processes. */
export function startAgentProxy(input: {
  runtime: {
    agentMessage(
      context: string,
      request: import("@coforge/protocol").LocalAgentMessageRequest,
      agentApiKey: string,
    ): Promise<unknown>;
    issueAgentContext?: (agentId: string, context?: string) => string;
  };
  port?: number;
}): AgentProxy {
  const maxBodyBytes = 64 * 1024;
  // This is deliberately a daemon-local Proxy token, not a cloud API key.
  // Its lifetime is bounded by the Agent process registration and it is
  // revoked when that registration stops. Keeping it stable means a long-idle
  // Agent can make its first request without receiving a new environment
  // variable or running a refresh command.
  const contexts = new Map<string, { agentId: string; context: string; agentApiKey: string }>();
  const server = Bun.serve({
    port: input.port ?? 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/agent/message")
        return new Response("not found", { status: 404 });
      if (request.headers.get("content-type")?.toLowerCase() !== "application/json")
        return new Response("unsupported media type", { status: 415 });
      const authorization = request.headers.get("authorization");
      const candidate = authorization?.match(/^Bearer (.+)$/)?.[1];
      const token = candidate && LOCAL_PROXY_TOKEN.test(candidate) ? candidate : undefined;
      const binding = token ? contexts.get(token) : undefined;
      if (!binding) return new Response("unauthorized", { status: 401 });
      try {
        const contentLength = request.headers.get("content-length");
        if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBodyBytes))
          return new Response("payload too large", { status: 413 });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > maxBodyBytes)
          return new Response("payload too large", { status: 413 });
        const body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body))
          return new Response("bad request", { status: 400 });
        const payload = body as Record<string, unknown>;
        if (
          typeof payload.requestId !== "string" ||
          payload.requestId.length === 0 ||
          !["check", "read", "send"].includes(payload.operation as string)
        )
          return new Response("bad request", { status: 400 });
        const result = await input.runtime.agentMessage(
          binding.context,
          {
            requestId: payload.requestId,
            operation: payload.operation as "check" | "read" | "send",
            target: typeof payload.target === "string" ? payload.target : undefined,
            body: typeof payload.body === "string" ? payload.body : undefined,
            // Identity is exclusively the token binding. Never accept caller
            // supplied agentId/context fields as authorization input.
            context: binding.context,
            // The Agent API key stays in this trusted registration and is
            // never serialized into the child process request.
          },
          binding.agentApiKey,
        );
        return Response.json(result);
      } catch (error) {
        // Deliberately do not expose runtime/transport exception text.
        if (error instanceof SyntaxError) return new Response("bad request", { status: 400 });
        return new Response("proxy request failed", { status: 502 });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/agent/message`,
    issue(agentId, agentApiKey) {
      if (!AGENT_API_KEY.test(agentApiKey)) throw new Error("invalid Agent API key");
      const token = `sfp_${randomBytes(32).toString("base64url")}`;
      const context = input.runtime.issueAgentContext?.(agentId, token) || token;
      contexts.set(token, { agentId, context, agentApiKey });
      return token;
    },
    revoke(token) {
      contexts.delete(token);
    },
    close() {
      server.stop(true);
      contexts.clear();
    },
  };
}
