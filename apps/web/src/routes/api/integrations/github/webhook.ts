import { createFileRoute } from "@tanstack/react-router";
import { githubWebhookHandler } from "#src/server/integrations/github-http.server";

export const Route = createFileRoute("/api/integrations/github/webhook")({
  server: { handlers: { POST: githubWebhookHandler } },
});
