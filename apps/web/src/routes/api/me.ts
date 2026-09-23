import { createFileRoute } from "@tanstack/react-router";

import { currentUserHandler } from "#src/server/auth/route-handlers.server";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: currentUserHandler,
    },
  },
});
