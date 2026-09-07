type ProxySocketData = {
  path: string;
  upstream?: WebSocket;
  pending: Array<string | Uint8Array>;
};

const webOrigin = "http://127.0.0.1:8789";
const centrifugoOrigin = "ws://127.0.0.1:8000";

Bun.serve<ProxySocketData>({
  hostname: "0.0.0.0",
  port: 8790,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/connection/")) {
      if (server.upgrade(request, { data: { path: url.pathname + url.search, pending: [] } }))
        return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    try {
      return await fetch(new Request(webOrigin + url.pathname + url.search, request));
    } catch {
      return new Response("Web application is starting", { status: 503 });
    }
  },
  websocket: {
    open(client) {
      const upstream = new WebSocket(centrifugoOrigin + client.data.path);
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

console.log("E2E same-origin WebSocket proxy listening on 8790");
