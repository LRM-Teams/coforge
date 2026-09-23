import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  AgentChannelManagement,
  type AgentChannelManagementRepository,
} from "#src/server/conversations/agent-channel-management.server";
import {
  channelManagementErrorResponse,
  readJsonBody,
  idempotencyKeyFrom,
} from "#src/server/agents/agent-channel-routes.server";

export type AgentChannelManagementPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelLeavePost(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const body = await readJsonBody(request);
  const idempotencyKey = idempotencyKeyFrom(body);
  try {
    const result = await repository.leave(principal.workspaceId, principal.agentId, channel);
    return Response.json({ protocolMajor: 1, idempotencyKey, ...result });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel leave failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/leave")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelLeavePost(
          request,
          params.channel,
          principal,
          new AgentChannelManagement(db),
        ),
    },
  },
});
