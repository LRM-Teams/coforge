import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import {
  AgentChannelManagement,
  type AgentChannelManagementRepository,
} from "#/server/conversations/agent-channel-management.server";
import {
  channelManagementErrorResponse,
  readJsonBody,
  requestIdFrom,
  requestIdFromQuery,
} from "#/server/agents/agent-channel-routes.shared";

export type AgentChannelManagementPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelMembersGet(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const requestId = requestIdFromQuery(request);
  try {
    const roster = await repository.members(principal.workspaceId, principal.agentId, channel);
    return Response.json({ protocolMajor: 1, requestId, ...roster });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel members failed");
  }
}

function memberInputFrom(
  body: Record<string, unknown> | undefined,
): Response | { user?: string; agent?: string } {
  if (body?.user !== undefined && typeof body.user !== "string")
    return new Response("user must be a string", { status: 400 });
  if (body?.agent !== undefined && typeof body.agent !== "string")
    return new Response("agent must be a string", { status: 400 });
  return {
    user: body?.user as string | undefined,
    agent: body?.agent as string | undefined,
  };
}

export async function handleAgentChannelMembersPost(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const body = await readJsonBody(request);
  const requestId = requestIdFrom(body);
  const input = memberInputFrom(body);
  if (input instanceof Response) return input;
  try {
    const result = await repository.addMember(
      principal.workspaceId,
      principal.agentId,
      channel,
      input,
    );
    return Response.json({ protocolMajor: 1, requestId, ...result });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel add-member failed");
  }
}

export async function handleAgentChannelMembersDelete(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const body = await readJsonBody(request);
  const requestId = requestIdFrom(body);
  const input = memberInputFrom(body);
  if (input instanceof Response) return input;
  try {
    const result = await repository.removeMember(
      principal.workspaceId,
      principal.agentId,
      channel,
      input,
    );
    return Response.json({ protocolMajor: 1, requestId, ...result });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel remove-member failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/channels_/$channel/members")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelMembersGet(
          request,
          params.channel,
          principal,
          new AgentChannelManagement(db),
        ),
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelMembersPost(
          request,
          params.channel,
          principal,
          new AgentChannelManagement(db),
        ),
      DELETE: ({ request, context: { principal, db }, params }) =>
        handleAgentChannelMembersDelete(
          request,
          params.channel,
          principal,
          new AgentChannelManagement(db),
        ),
    },
  },
});
