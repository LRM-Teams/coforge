import { createFileRoute } from "@tanstack/react-router";
import { e2eToken } from "@/server/auth/e2e-device-auth.server";
export const Route = createFileRoute("/oauth/token")({
  server: { handlers: { POST: ({ request }) => e2eToken(request) } },
});
