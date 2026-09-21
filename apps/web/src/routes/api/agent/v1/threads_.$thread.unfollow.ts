import { createFileRoute } from "@tanstack/react-router";
import type { AgentThreadAttentionResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  unfollowAgentThread,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.service";
import { AgentMessageValidationError } from "#/server/conversations/agent-message-validation-error.server";

export type AgentThreadUnfollowPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentThreadUnfollowPost(
  request: Request,
  thread: string,
  principal: AgentThreadUnfollowPrincipal,
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
    await unfollowAgentThread(repository, scope, thread);
    const response: AgentThreadAttentionResponse = {
      protocolMajor: 1,
      idempotencyKey,
      target: thread,
      followed: false,
    };
    return Response.json(response);
  } catch (error) {
    if (error instanceof AgentMessageValidationError)
      return new Response(error.message, { status: 400 });
    if (error instanceof Error && error.message === "unfollow requires a channel thread target")
      return new Response(error.message, { status: 400 });
    return new Response("thread unfollow failed", { status: 400 });
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
