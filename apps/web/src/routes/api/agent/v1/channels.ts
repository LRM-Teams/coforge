import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import {
  AgentChannelManagement,
  type AgentChannelManagementRepository,
} from "#/server/conversations/agent-channel-management.server";
import {
  channelManagementErrorResponse,
  readJsonBody,
  idempotencyKeyFrom,
} from "#/server/agents/agent-channel-routes.shared";

export type AgentChannelManagementPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentChannelsPost(
  request: Request,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
): Promise<Response> {
  const body = await readJsonBody(request);
  const idempotencyKey = idempotencyKeyFrom(body);
  if (!body || typeof body.name !== "string")
    return new Response("name is required", { status: 400 });
  if (body.description !== undefined && typeof body.description !== "string")
    return new Response("description must be a string", { status: 400 });
  try {
    const result = await repository.create(
      principal.workspaceId,
      principal.agentId,
      body.name,
      body.description as string | undefined,
    );
    return Response.json({ protocolMajor: 1, idempotencyKey, ...result });
  } catch (error) {
    return channelManagementErrorResponse(error, "channel create failed");
  }
}

export const Route = createFileRoute("/api/agent/v1/channels")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentChannelsPost(request, principal, new AgentChannelManagement(db)),
    },
  },
});
