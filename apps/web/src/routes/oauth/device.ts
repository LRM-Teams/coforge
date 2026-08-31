import { createFileRoute } from "@tanstack/react-router";
import { e2eDevice } from "@/server/auth/e2e-device-auth.server";
export const Route = createFileRoute("/oauth/device")({
  server: { handlers: { POST: ({ request }) => e2eDevice(request) } },
});
