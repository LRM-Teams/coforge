import { createFileRoute } from "@tanstack/react-router";
import { deviceTokenRequest } from "@/server/auth/device-auth-http.server";
export const Route = createFileRoute("/oauth/token")({
  server: { handlers: { POST: ({ request }) => deviceTokenRequest(request) } },
});
