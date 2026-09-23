import { createFileRoute } from "@tanstack/react-router";
import type { AgentSearchResponse, AgentMessage } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  searchAgentMessages,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.server";

export type AgentMessagesSearchGetPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentMessagesSearchGet(
  request: Request,
  principal: AgentMessagesSearchGetPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const idempotencyKey = query.get("idempotencyKey") || crypto.randomUUID();
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const results = (await searchAgentMessages(repository, scope, {
      query: query.get("query") ?? undefined,
      target: query.get("target") ?? undefined,
      sender: query.get("sender") ?? undefined,
      sort: query.get("sort") === "recent" ? "recent" : "relevance",
      limit: query.has("limit") ? Number(query.get("limit")) : undefined,
      offset: query.has("offset") ? Number(query.get("offset")) : undefined,
    })) as AgentMessage[];
    const response: AgentSearchResponse = {
      protocolMajor: 1,
      idempotencyKey,
      results,
    };
    return Response.json(response);
  } catch {
    return Response.json({ error: "invalid message query" }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/agent/v1/messages_/search")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentMessagesSearchGet(
          request,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
