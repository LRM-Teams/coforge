import { createFileRoute } from "@tanstack/react-router";
import type { AgentSearchResponse, AgentMessage } from "@lrm/coforge-sdk/agent";
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
  /** An optional time bound as ISO text; anything that is not a date rejects the query. */
  const instant = (name: "before" | "after") => {
    const value = query.get(name);
    if (!value) return undefined;
    const time = Date.parse(value);
    if (Number.isNaN(time)) throw new Error(`invalid ${name}`);
    return new Date(time).toISOString();
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
