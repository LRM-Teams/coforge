import { createFileRoute } from "@tanstack/react-router";

import { loginCallbackHandler } from "#src/server/auth/route-handlers.server";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: loginCallbackHandler,
    },
  },
});
