import { createFileRoute } from "@tanstack/react-router";

import { createCentrifugoRpcHandler } from "#/server/centrifugo/rpc-composition.server";

const handler = createCentrifugoRpcHandler();

export const Route = createFileRoute("/api/internal/centrifugo")({
  server: {
    handlers: {
      POST: ({ request }) => handler.handleRequest(request),
    },
  },
});
