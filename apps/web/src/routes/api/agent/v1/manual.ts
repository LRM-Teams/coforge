import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http-middleware.server";
import { PrismaAgentManualEventRepository } from "#/server/db/repositories/agent-manual-event.repositories.server";
import {
  recordManualEvent,
  resolveManualGet,
  type AgentManualEventRepository,
} from "#/server/agents/agent-manual.server";

export type AgentManualGetPrincipal = { workspaceId: string; agentId: string };

/** `GET /api/agent/v1/manual` — Agent Manual `get`: topic content, or the generated
 * `index` catalog. Mirrors Raft 1.0.32's `/knowledge` response shape (`ok`, `docId`,
 * `topicOrPath`, `docVersion`, `docState`, `contentType`, `content`). */
export async function handleAgentManualGet(
  request: Request,
  principal: AgentManualGetPrincipal,
  repository: AgentManualEventRepository | undefined,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const topic = query.get("topic") ?? "";
  const intent = (query.get("intent") ?? "").trim();
  const reason = (query.get("reason") ?? "").trim();
  const outcome = resolveManualGet({ topic, intent, reason });
  if (outcome.status !== 400)
    await recordManualEvent(
      repository,
      principal,
      {
        kind: "get",
        topicOrQuery: topic,
        intent,
        reason,
        outcome: outcome.recordOutcome,
        resultSlugs: outcome.status === 200 ? outcome.resultSlugs : [],
      },
      (error) => console.error("agent manual event logging failed", error),
    );
  return Response.json(outcome.body, { status: outcome.status });
}

export const Route = createFileRoute("/api/agent/v1/manual")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentManualGet(request, principal, new PrismaAgentManualEventRepository(db)),
    },
  },
});
