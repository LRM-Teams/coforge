import { createFileRoute } from "@tanstack/react-router";
import type { AgentEventsResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  drainAgentEvents,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.service";

export type AgentEventsGetPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentEventsGet(
  request: Request,
  principal: AgentEventsGetPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const idempotencyKey = query.get("idempotencyKey") || crypto.randomUUID();
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const limit = query.has("limit") ? Number(query.get("limit")) : undefined;
    if (limit !== undefined && !Number.isInteger(limit)) throw new Error("invalid events limit");
    const result = await drainAgentEvents(
      repository,
      scope,
      limit,
      query.get("target") || undefined,
    );
    const response: AgentEventsResponse = {
      protocolMajor: 1,
      idempotencyKey,
      events: result.messages,
      hasMore: result.hasMore,
    };
    return Response.json(response);
  } catch {
    return Response.json({ error: "invalid events query" }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/agent/v1/events")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentEventsGet(request, principal, new PrismaDirectConversationRepository(db)),
    },
  },
});
