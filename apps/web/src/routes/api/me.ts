import { createFileRoute } from "@tanstack/react-router";

import { currentUserHandler } from "@/identity/route-handlers";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: currentUserHandler,
    },
  },
});
