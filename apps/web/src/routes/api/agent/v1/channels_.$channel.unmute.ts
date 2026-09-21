import { createFileRoute } from "@tanstack/react-router";
import type { AgentChannelAttentionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  muteAgentChannel,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.service";
import { AgentMessageValidationError } from "#/server/conversations/agent-message-validation-error.server";

export type AgentChannelMutePrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelUnmutePost(
  request: Request,
  channel: string,
  principal: AgentChannelMutePrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const body = (await request.json().catch(() => undefined)) as
      | { idempotencyKey?: unknown }
      | undefined;
    const idempotencyKey =
      body && typeof body.idempotencyKey === "string" && body.idempotencyKey
        ? body.idempotencyKey
        : crypto.randomUUID();
    await muteAgentChannel(repository, scope, channel, false);
    const response: AgentChannelAttentionResponse = {
      protocolMajor: 1,
      idempotencyKey,
      target: channel,
      muted: false,
    };
    return Response.json(response);
  } catch (error) {
    if (error instanceof AgentMessageValidationError)
      return new Response(error.message, { status: 400 });
    if (error instanceof Error && error.message === "mute requires a channel target")
      return new Response(error.message, { status: 400 });
    return new Response("channel unmute failed", { status: 400 });
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/unmute")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelUnmutePost(
          request,
          params.channel,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
