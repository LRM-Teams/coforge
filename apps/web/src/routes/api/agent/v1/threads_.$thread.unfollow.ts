import { createFileRoute } from "@tanstack/react-router";
import type { AgentThreadAttentionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "@/server/db/repositories/direct-conversation.repositories.server";
import {
  unfollowAgentThread,
  type AgentMessageRepository,
} from "@/server/agents/agent-messages.server";
import {
  agentIdempotencyKey,
  agentRouteErrorResponse,
  readAgentJsonBody,
} from "@/server/agents/agent-http-routes.server";

export type AgentThreadUnfollowPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentThreadUnfollowPost(
  request: Request,
  thread: string,
  principal: AgentThreadUnfollowPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    const idempotencyKey = agentIdempotencyKey(await readAgentJsonBody(request));
    await unfollowAgentThread(repository, scope, thread);
    const response: AgentThreadAttentionResponse = {
      protocolMajor: 1,
      idempotencyKey,
      target: thread,
      followed: false,
    };
    return Response.json(response);
  } catch (error) {
    return agentRouteErrorResponse(error, "thread unfollow failed", [
      "unfollow requires a channel thread target",
    ]);
  }
}

export const Route = createFileRoute("/api/agent/v1/threads_/$thread/unfollow")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db }, params }) =>
        handleAgentThreadUnfollowPost(
          request,
          params.thread,
          principal,
          new PrismaDirectConversationRepository(db),
        ),
    },
  },
});
