import { createFileRoute } from "@tanstack/react-router";

import { logoutHandler } from "@/identity/route-handlers";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      GET: logoutHandler,
    },
  },
});
