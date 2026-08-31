import { createFileRoute } from "@tanstack/react-router";
import { oauthDiscovery } from "@/server/auth/e2e-device-auth.server";

export const Route = createFileRoute("/.well-known/oauth-authorization-server")({
  server: { handlers: { GET: ({ request }) => oauthDiscovery(request) } },
});
