const replica = process.env.BACKEND_REPLICA ?? "backend-unknown";

const identities = new Map([
  ["alice-token", "alice"],
  ["bob-token", "bob"],
]);

const allowedConversations = new Map([
  ["alice", new Set(["conversation:alpha", "conversation:shared"])],
  ["bob", new Set(["conversation:beta", "conversation:shared"])],
]);

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function decodeData(value: unknown): unknown {
  if (typeof value !== "string") return undefined;

  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function encodeData(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

Bun.serve({
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, replica });
    }

    if (request.method === "GET" && url.pathname === "/test-control/online") {
      const channel = url.searchParams.get("channel");
      if (!channel?.startsWith("conversation:")) {
        return json({ error: "invalid channel" }, 400);
      }

      const response = await fetch("http://centrifugo-a:8000/api/presence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "lrm-1583-disposable-api-key",
        },
        body: JSON.stringify({ channel }),
      });
      if (!response.ok) {
        return json({ error: "presence unavailable", replica }, 502);
      }

      const body = (await response.json()) as {
        result?: { presence?: Record<string, { user?: string }> };
      };
      const connections = Object.entries(body.result?.presence ?? {})
        .map(([client, presence]) => ({ client, user: presence.user ?? "" }))
        .sort((left, right) => left.client.localeCompare(right.client));
      return json({ channel, connections, replica });
    }

    if (request.method === "POST" && url.pathname === "/centrifugo/connect") {
      const body = (await request.json()) as { b64data?: unknown };
      const data = decodeData(body.b64data) as { accessToken?: unknown } | undefined;
      const user =
        typeof data?.accessToken === "string" ? identities.get(data.accessToken) : undefined;

      if (!user) {
        return json({ error: { code: 403, message: "permission denied" } });
      }

      return json({ result: { user, meta: { replica } } });
    }

    if (request.method === "POST" && url.pathname === "/centrifugo/subscribe") {
      const body = (await request.json()) as {
        channel?: unknown;
        user?: unknown;
      };

      if (
        typeof body.user !== "string" ||
        typeof body.channel !== "string" ||
        !allowedConversations.get(body.user)?.has(body.channel)
      ) {
        return json({ error: { code: 403, message: "permission denied" } });
      }

      return json({ result: {} });
    }

    if (request.method === "POST" && url.pathname === "/centrifugo/rpc") {
      const body = (await request.json()) as {
        b64data?: unknown;
        method?: unknown;
        user?: unknown;
      };
      const data = decodeData(body.b64data) as
        | {
            clientMessageId?: unknown;
            conversationId?: unknown;
            text?: unknown;
          }
        | undefined;

      if (
        body.method !== "message.publish" ||
        typeof body.user !== "string" ||
        typeof data?.clientMessageId !== "string" ||
        typeof data.conversationId !== "string" ||
        typeof data.text !== "string" ||
        !allowedConversations.get(body.user)?.has(data.conversationId)
      ) {
        return json({ error: { code: 403, message: "permission denied" } });
      }

      const canonicalMessage = {
        clientMessageId: data.clientMessageId,
        conversationId: data.conversationId,
        messageId: `canonical:${body.user}:${data.clientMessageId}`,
        sender: body.user,
        text: data.text,
      };

      const publication = await fetch("http://centrifugo-a:8000/api/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "lrm-1583-disposable-api-key",
        },
        body: JSON.stringify({
          channel: data.conversationId,
          data: canonicalMessage,
        }),
      });

      if (!publication.ok) {
        return json({ error: { code: 500, message: "publish failed" } });
      }

      return json({ result: { b64data: encodeData(canonicalMessage) } });
    }

    return json({ error: "not found" }, 404);
  },
});
