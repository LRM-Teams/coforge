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
  idempotencyKeyFromQuery,
} from "#/server/agents/agent-channel-routes.server";

export type AgentChannelManagementPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelGet(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const idempotencyKey = idempotencyKeyFromQuery(request);
  try {
    const info = await repository.info(principal.workspaceId, principal.agentId, channel);
    return Response.json({ protocolMajor: 1, idempotencyKey, channel: info });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel info failed");
  }
}

export async function handleAgentChannelPatch(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const body = await readJsonBody(request);
  const idempotencyKey = idempotencyKeyFrom(body);
  if (body?.name !== undefined && typeof body.name !== "string")
    return new Response("name must be a string", { status: 400 });
  if (body?.description !== undefined && typeof body.description !== "string")
    return new Response("description must be a string", { status: 400 });
  try {
    const info = await repository.update(principal.workspaceId, principal.agentId, channel, {
      name: body?.name as string | undefined,
      description: body?.description as string | undefined,
    });
    return Response.json({ protocolMajor: 1, idempotencyKey, channel: info });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel update failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelGet(request, params.channel, principal, new AgentChannelManagement(db)),
      PATCH: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelPatch(request, params.channel, principal, new AgentChannelManagement(db)),
    },
  },
});
