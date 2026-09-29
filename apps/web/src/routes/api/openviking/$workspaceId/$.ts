import { createFileRoute } from "@tanstack/react-router";
import { handleOpenVikingProxyRoute } from "#src/server/openviking/policy-gateway.server";

export const Route = createFileRoute("/api/openviking/$workspaceId/$")({
  server: {
    handlers: {
      GET: handleOpenVikingProxyRoute,
      POST: handleOpenVikingProxyRoute,
      PUT: handleOpenVikingProxyRoute,
      PATCH: handleOpenVikingProxyRoute,
      DELETE: handleOpenVikingProxyRoute,
    },
  },
});
