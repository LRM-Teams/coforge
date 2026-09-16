import { createFileRoute } from "@tanstack/react-router";
import type { CloudAgentMessageResponse } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  resolveAgentMessage,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.service";
import { AgentMessageValidationError } from "#/server/conversations/agent-message-validation-error.server";

export type AgentMessageResolvePrincipal = { workspaceId: string; agentId: string };

export async function handleAgentMessageResolveGet(
  request: Request,
  messageId: string,
  principal: AgentMessageResolvePrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const requestId = query.get("requestId") || crypto.randomUUID();
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const message = await resolveAgentMessage(repository, scope, messageId);
    const response: CloudAgentMessageResponse = {
      protocolMajor: 1,
      requestId,
      accepted: true,
      attentionCount: 0,
      messages: [message],
    };
    return Response.json(response);
  } catch (error) {
    if (error instanceof AgentMessageValidationError)
      return new Response(error.message, { status: 400 });
    return new Response("message resolve failed", { status: 400 });
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
