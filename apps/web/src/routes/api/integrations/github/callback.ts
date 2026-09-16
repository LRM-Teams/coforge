import { createFileRoute } from "@tanstack/react-router";
import { githubCallbackHandler } from "../../../../server/integrations/github-http.server";

export const Route = createFileRoute("/api/integrations/github/callback")({
  server: { handlers: { GET: githubCallbackHandler } },
});
