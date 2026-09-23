import { createFileRoute } from "@tanstack/react-router";
import { createAgentActivityPublicationHandler } from "#src/server/agents/agent-activity-publish.server";

const handlePublication = createAgentActivityPublicationHandler();

export const Route = createFileRoute("/api/internal/centrifugo-agent-activity")({
  server: {
    handlers: {
      POST: ({ request }) => handlePublication(request),
    },
  },
});
