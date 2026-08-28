import { createFileRoute } from "@tanstack/react-router";

import { loginCallbackHandler } from "@/server/auth/route-handlers.server";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: loginCallbackHandler,
    },
  },
});
