import { createFileRoute } from "@tanstack/react-router";
import type { AgentSearchResponse, AgentMessage } from "@lrm/coforge-sdk/agent";
import type { AgentMessageValidationMessage } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  searchAgentMessages,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";

export type AgentMessagesSearchGetPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentMessagesSearchGet(
  request: Request,
  principal: AgentMessagesSearchGetPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  // A time bound that is not a date is refused up front with a validation message the daemon
  // shows the Agent unchanged (it is in `AGENT_MESSAGE_VALIDATION_MESSAGES`).
  for (const name of ["before", "after"] as const) {
    const value = query.get(name);
    if (value && Number.isNaN(Date.parse(value))) {
      const message: AgentMessageValidationMessage = `search \`${name}\` must be an ISO time, such as 2026-09-01T00:00:00Z`;
      return new Response(message, { status: 400 });
    }
  }
  const instant = (name: "before" | "after") => {
    const value = query.get(name);
    return value ? new Date(value).toISOString() : undefined;
  };
  const idempotencyKey = query.get("idempotencyKey") || crypto.randomUUID();
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const results = (await searchAgentMessages(repository, scope, {
      query: query.get("query") ?? undefined,
      target: query.get("target") ?? undefined,
      sender: query.get("sender") ?? undefined,
      sort: query.get("sort") === "recent" ? "recent" : "relevance",
      before: instant("before"),
      after: instant("after"),
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
