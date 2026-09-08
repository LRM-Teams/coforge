import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthorizationRequest } from "@/server/auth/device-auth-http.server";
export const Route = createFileRoute("/oauth/device")({
  server: { handlers: { POST: ({ request }) => deviceAuthorizationRequest(request) } },
});
