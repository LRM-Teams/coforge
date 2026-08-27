import { createFileRoute } from "@tanstack/react-router";

import { loginStartHandler } from "@/identity/route-handlers";

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: loginStartHandler,
    },
  },
});
