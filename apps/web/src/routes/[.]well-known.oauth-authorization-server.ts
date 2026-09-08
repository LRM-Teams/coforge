import { createFileRoute } from "@tanstack/react-router";
import { oauthDiscovery } from "@/server/auth/device-auth-http.server";

export const Route = createFileRoute("/.well-known/oauth-authorization-server")({
  server: { handlers: { GET: ({ request }) => oauthDiscovery(request) } },
});
