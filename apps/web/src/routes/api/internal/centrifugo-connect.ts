import { createFileRoute } from "@tanstack/react-router";

import { authenticateCentrifugoConnect } from "#/server/centrifugo/connect-proxy.server";
import { getDatabaseClient } from "#/server/db/client.server";
import { PrismaDaemonApiKeyRepository } from "#/server/db/repositories/daemon-api-key.repositories.server";

export const Route = createFileRoute("/api/internal/centrifugo-connect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
        if (!secret || request.headers.get("x-coforge-centrifugo-proxy-secret") !== secret)
          return Response.json(
            { error: { code: 403, message: "proxy authorization failed" } },
            { status: 403 },
          );
        const db = getDatabaseClient();
        if (!db)
          return Response.json(
            { error: { code: 503, message: "database unavailable" } },
            { status: 503 },
          );
        return authenticateCentrifugoConnect(request, {
          daemonApiKeys: new PrismaDaemonApiKeyRepository(db),
          computerBelongsToWorkspace: async (workspaceId, computerId) =>
            Boolean(
              await db.workspaceComputer.findUnique({
                where: { workspaceId_computerId: { workspaceId, computerId } },
                select: { id: true },
              }),
            ),
        });
      },
    },
  },
});
