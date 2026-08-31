import { createFileRoute } from "@tanstack/react-router";

import { daemonRuntimeJwks } from "#/server/auth/daemon-token.server";

export const Route = createFileRoute("/api/jwks")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return Response.json(await daemonRuntimeJwks(), {
            headers: { "cache-control": "public, max-age=300" },
          });
        } catch {
          return Response.json({ error: "JWKS is not configured" }, { status: 503 });
        }
      },
    },
  },
});
