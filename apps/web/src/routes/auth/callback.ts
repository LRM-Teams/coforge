import { createFileRoute } from "@tanstack/react-router";

import { loginCallbackHandler } from "@/identity/route-handlers";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: loginCallbackHandler,
    },
  },
});
