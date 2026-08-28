import { createFileRoute } from "@tanstack/react-router";

import { loginStartHandler } from "@/server/auth/route-handlers.server";

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: loginStartHandler,
    },
  },
});
