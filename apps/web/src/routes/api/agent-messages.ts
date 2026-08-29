import { createFileRoute } from "@tanstack/react-router";

import { createAgentMessageHttpHandler } from "#/server/agents/agent-message-http.server";

const handler = createAgentMessageHttpHandler();

export const Route = createFileRoute("/api/agent-messages")({
  server: {
    handlers: {
      POST: ({ request }) => handler.handleRequest(request),
    },
  },
});
