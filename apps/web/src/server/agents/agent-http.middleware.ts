import { createMiddleware } from "@tanstack/react-start";
import { authenticateAgentHttpRequest } from "./agent-api-http.server";

export const agentAuthMiddleware = createMiddleware().server(async ({ next, request }) => {
  try {
    const principal = await authenticateAgentHttpRequest(request);
    return next({ context: { principal } });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
});
