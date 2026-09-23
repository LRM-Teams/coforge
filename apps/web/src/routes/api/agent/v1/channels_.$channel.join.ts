import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http-middleware.server";
import {
  AgentChannelManagement,
  type AgentChannelManagementRepository,
} from "#/server/conversations/agent-channel-management.server";
import {
  channelManagementErrorResponse,
  readJsonBody,
  idempotencyKeyFrom,
} from "#/server/agents/agent-channel-routes.server";

export type AgentChannelManagementPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelJoinPost(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const body = await readJsonBody(request);
  const idempotencyKey = idempotencyKeyFrom(body);
  try {
    const result = await repository.join(principal.workspaceId, principal.agentId, channel);
    return Response.json({ protocolMajor: 1, idempotencyKey, ...result });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel join failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/join")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelJoinPost(
          request,
          params.channel,
          principal,
          new AgentChannelManagement(db),
        ),
    },
  },
});
