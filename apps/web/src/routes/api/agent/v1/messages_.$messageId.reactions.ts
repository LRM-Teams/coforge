import { createFileRoute } from "@tanstack/react-router";
import type { AgentReactionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  reactToAgentMessage,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.service";
import { AgentMessageValidationError } from "#/server/conversations/agent-message-validation-error.server";

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
    const body = (await request.json().catch(() => undefined)) as
      | { requestId?: unknown; emoji?: unknown }
      | undefined;
    const requestId =
      body && typeof body.requestId === "string" && body.requestId
        ? body.requestId
        : crypto.randomUUID();
    const emoji = body && typeof body.emoji === "string" ? body.emoji : "";
    const result = await reactToAgentMessage(repository, scope, messageId, emoji, active);
    const response: AgentReactionResponse = {
      protocolMajor: 1,
      requestId,
      messageId: result.messageId,
      emoji,
      active,
    };
    return Response.json(response);
  } catch (error) {
    if (error instanceof AgentMessageValidationError)
      return new Response(error.message, { status: 400 });
    return new Response("message reaction failed", { status: 400 });
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
