import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http-middleware.server";
import { PrismaAgentManualEventRepository } from "#/server/db/repositories/agent-manual-event.repositories.server";
import {
  recordManualEvent,
  resolveManualSearch,
  type AgentManualEventRepository,
} from "#/server/agents/agent-manual.server";

export type AgentManualSearchPrincipal = { workspaceId: string; agentId: string };

/** `GET /api/agent/v1/manual/search` — Agent Manual `search`: plain keyword scoring
 * over the topic registry (v1, no embeddings). Mirrors Raft 1.0.32's `/knowledge/search` response
 * shape (`ok`, `query`, `scope: null`, `results`). */
export async function handleAgentManualSearchGet(
  request: Request,
  principal: AgentManualSearchPrincipal,
  repository: AgentManualEventRepository | undefined,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const search = (query.get("query") ?? "").trim();
  const intent = (query.get("intent") ?? "").trim();
  const reason = (query.get("reason") ?? "").trim();
  const outcome = resolveManualSearch({ query: search, intent, reason });
  if (outcome.status !== 400)
    await recordManualEvent(
      repository,
      principal,
      {
        kind: "search",
        topicOrQuery: search,
        intent,
        reason,
        outcome: outcome.recordOutcome,
        resultSlugs: outcome.status === 200 ? outcome.resultSlugs : [],
      },
      (error) => console.error("agent manual event logging failed", error),
    );
  return Response.json(outcome.body, { status: outcome.status });
}

export const Route = createFileRoute("/api/agent/v1/manual_/search")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentManualSearchGet(request, principal, new PrismaAgentManualEventRepository(db)),
    },
  },
});
