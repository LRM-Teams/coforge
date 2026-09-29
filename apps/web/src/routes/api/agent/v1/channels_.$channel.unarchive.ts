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
  type AgentChannelManagementPrincipal,
} from "#src/server/agents/agent-channel-routes.server";

export async function handleAgentChannelUnarchivePost(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const body = await readJsonBody(request);
  const idempotencyKey = idempotencyKeyFrom(body);
  try {
    const result = await repository.setArchived(
      principal.workspaceId,
      principal.agentId,
      channel,
      false,
    );
    return Response.json({ idempotencyKey, ...result });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel unarchive failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/unarchive")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelUnarchivePost(
          request,
          params.channel,
          principal,
          new AgentChannelManagement(db),
        ),
    },
  },
});
