import { createFileRoute } from "@tanstack/react-router";

import { createCentrifugoRpcHandler } from "#src/server/centrifugo/rpc-composition.server";

// Composed on the first request, not at import: with a database configured, composing starts the
// Agent activity sweep, and importing the route tree (the router, tests) must not.
let handler: ReturnType<typeof createCentrifugoRpcHandler> | undefined;

export const Route = createFileRoute("/api/internal/centrifugo")({
  server: {
    handlers: {
      POST: ({ request }) => (handler ??= createCentrifugoRpcHandler()).handleRequest(request),
    },
  },
});
