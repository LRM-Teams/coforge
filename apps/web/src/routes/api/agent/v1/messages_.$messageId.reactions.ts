import { createFileRoute } from "@tanstack/react-router";
import type { AgentReactionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  reactToAgentMessage,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.server";
import {
  agentIdempotencyKey,
  agentRouteErrorResponse,
  readAgentJsonBody,
} from "#/server/agents/agent-http-routes.server";

export type AgentMessageReactionPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentMessageReaction(
  request: Request,
  messageId: string,
  active: boolean,
  principal: AgentMessageReactionPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const body = await readAgentJsonBody(request);
    const idempotencyKey = agentIdempotencyKey(body);
    const emoji = typeof body?.emoji === "string" ? body.emoji : "";
    const result = await reactToAgentMessage(repository, scope, messageId, emoji, active);
    const response: AgentReactionResponse = {
      protocolMajor: 1,
      idempotencyKey,
      messageId: result.messageId,
      emoji,
      active,
    };
    return Response.json(response);
  } catch (error) {
    return agentRouteErrorResponse(error, "message reaction failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/messages_/$messageId/reactions")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentMessageReaction(
          request,
          params.messageId,
          true,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
      DELETE: ({ request, context: { principal, db }, params }) =>
        handleAgentMessageReaction(
          request,
          params.messageId,
          false,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
