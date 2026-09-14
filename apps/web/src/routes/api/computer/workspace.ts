import { WORKSPACE_GET_METHOD } from "@coforge/protocol";
import { createFileRoute } from "@tanstack/react-router";

import { createComputerHttpHandler } from "#/server/computers/computer-http.server";

const handler = createComputerHttpHandler();

export const Route = createFileRoute("/api/computer/workspace")({
  server: {
    handlers: {
      POST: ({ request }) => handler.handleRequest(request, WORKSPACE_GET_METHOD),
    },
  },
});
