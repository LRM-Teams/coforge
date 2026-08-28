import { createFileRoute } from "@tanstack/react-router";

import { logoutHandler } from "@/server/auth/route-handlers.server";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      GET: logoutHandler,
    },
  },
});
