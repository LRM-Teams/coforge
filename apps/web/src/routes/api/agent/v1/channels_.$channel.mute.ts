import { createFileRoute } from "@tanstack/react-router";
import type { AgentChannelAttentionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "@/server/db/repositories/direct-conversation.repositories.server";
import {
  muteAgentChannel,
  type AgentMessageRepository,
} from "@/server/agents/agent-messages.server";
import {
  agentIdempotencyKey,
  agentRouteErrorResponse,
  readAgentJsonBody,
} from "@/server/agents/agent-http-routes.server";

export type AgentChannelMutePrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelMutePost(
  request: Request,
  channel: string,
  muted: boolean,
  principal: AgentChannelMutePrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const idempotencyKey = agentIdempotencyKey(await readAgentJsonBody(request));
    await muteAgentChannel(repository, scope, channel, muted);
    const response: AgentChannelAttentionResponse = {
      protocolMajor: 1,
      idempotencyKey,
      target: channel,
      muted,
    };
    return Response.json(response);
  } catch (error) {
    return agentRouteErrorResponse(error, "channel mute failed", [
      "mute requires a channel target",
    ]);
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/mute")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelMutePost(
          request,
          params.channel,
          true,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
