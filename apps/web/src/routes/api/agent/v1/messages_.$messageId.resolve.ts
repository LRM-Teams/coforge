import { createFileRoute } from "@tanstack/react-router";
import type { AgentResolveResponse, AgentMessage } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  resolveAgentMessage,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.server";
import {
  agentIdempotencyKeyFromQuery,
  agentRouteErrorResponse,
} from "#/server/agents/agent-http-routes.server";

export type AgentMessageResolvePrincipal = { workspaceId: string; agentId: string };

export async function handleAgentMessageResolveGet(
  request: Request,
  messageId: string,
  principal: AgentMessageResolvePrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const idempotencyKey = agentIdempotencyKeyFromQuery(request);
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const message = await resolveAgentMessage(repository, scope, messageId);
    const response: AgentResolveResponse = {
      protocolMajor: 1,
      idempotencyKey,
      message: message as AgentMessage,
    };
    return Response.json(response);
  } catch (error) {
    return agentRouteErrorResponse(error, "message resolve failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/messages_/$messageId/resolve")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db }, params }) =>
        handleAgentMessageResolveGet(
          request,
          params.messageId,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
