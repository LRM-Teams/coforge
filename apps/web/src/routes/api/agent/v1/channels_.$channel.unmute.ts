import { createFileRoute } from "@tanstack/react-router";
import type { AgentChannelAttentionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  muteAgentChannel,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.service";
import {
  agentIdempotencyKey,
  agentRouteErrorResponse,
  readAgentJsonBody,
} from "#/server/agents/agent-http-routes.shared";

export type AgentChannelMutePrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelUnmutePost(
  request: Request,
  channel: string,
  principal: AgentChannelMutePrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const idempotencyKey = agentIdempotencyKey(await readAgentJsonBody(request));
    await muteAgentChannel(repository, scope, channel, false);
    const response: AgentChannelAttentionResponse = {
      protocolMajor: 1,
      idempotencyKey,
      target: channel,
      muted: false,
    };
    return Response.json(response);
  } catch (error) {
    return agentRouteErrorResponse(error, "channel unmute failed", [
      "mute requires a channel target",
    ]);
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
