// Local same-origin proxy for host deployment without Caddy.
// Fronts the Nitro backend and forwards /connection WebSockets to Centrifugo.
// Parameterized version of scripts/e2e/same-origin-proxy.ts:
//   COFORGE_PROXY_PORT (default 8790)
//   COFORGE_PROXY_WEB_ORIGIN (default http://127.0.0.1:8789)
//   COFORGE_PROXY_CENTRIFUGO_ORIGIN (default ws://127.0.0.1:18000)
type ProxySocketData = {
  path: string;
  protocol?: string;
  upstream?: WebSocket;
  pending: Array<string | Uint8Array<ArrayBuffer>>;
};

const port = Number(process.env.COFORGE_PROXY_PORT ?? 8790);
const webOrigin = process.env.COFORGE_PROXY_WEB_ORIGIN ?? "http://127.0.0.1:8789";
const centrifugoOrigin =
  process.env.COFORGE_PROXY_CENTRIFUGO_ORIGIN ?? "ws://127.0.0.1:18000";

export async function forwardWebRequest(request: Request, origin: string) {
  const url = new URL(request.url);
  try {
    return await fetch(new Request(origin + url.pathname + url.search, request), {
      redirect: "manual",
    });
  } catch {
    return new Response("Web application is starting", { status: 503 });
  }
}

Bun.serve<ProxySocketData>({
  hostname: "0.0.0.0",
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/connection/")) {
      const protocol = request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((value) => value.trim())
        .find((value) => value === "centrifuge-protobuf");
      if (
        server.upgrade(request, {
          headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
          data: { path: url.pathname + url.search, protocol, pending: [] },
        })
      )
        return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return forwardWebRequest(request, webOrigin);
  },
  websocket: {
    open(client) {
      const upstream = new WebSocket(centrifugoOrigin + client.data.path, client.data.protocol);
      upstream.binaryType = "arraybuffer";
      client.data.upstream = upstream;
      upstream.onopen = () => {
        for (const message of client.data.pending) upstream.send(message);
        client.data.pending.length = 0;
      };
      upstream.onmessage = (event) => client.send(event.data);
      upstream.onclose = (event) => client.close(event.code, event.reason);
      upstream.onerror = () => client.close(1011, "Upstream WebSocket error");
    },
    message(client, message) {
      const upstream = client.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
      else client.data.pending.push(message);
    },
    close(client) {
      client.data.upstream?.close();
    },
  },
});

console.log(
  `Local same-origin proxy on ${port}: web=${webOrigin} centrifugo=${centrifugoOrigin}`,
);
