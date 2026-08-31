import { createFileRoute } from "@tanstack/react-router";

import { computerRegistrationJwks } from "#/server/auth/daemon-api-key.server";

export const Route = createFileRoute("/api/jwks")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return Response.json(await computerRegistrationJwks(), {
            headers: { "cache-control": "public, max-age=300" },
          });
        } catch {
          return Response.json(
            { error: "Computer registration JWT is not configured" },
            { status: 503 },
          );
        }
      },
    },
  },
});
