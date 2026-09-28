import { createFileRoute } from "@tanstack/react-router";
import type { AgentMentionPendingResponse } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  pendingMentionActionsForAgent,
  type PendingMentionActionView,
} from "#src/server/conversations/pending-mention-actions.server";

/** `GET /api/agent/v1/mention-actions/pending` — `coforge mention pending`: the calling Agent's
 * mentions that reached no one because the target was outside the channel at send time. */
export async function handleAgentMentionPendingGet(
  principal: { workspaceId: string; agentId: string },
  deps: {
    pendingMentionActions(
      workspaceId: string,
      agentId: string,
    ): Promise<PendingMentionActionView[]>;
  },
): Promise<Response> {
  const actions = await deps.pendingMentionActions(principal.workspaceId, principal.agentId);
  const body: AgentMentionPendingResponse = {
    ok: true,
    pendingMentionActions: actions.map((action) => ({
      resolutionId: action.resolutionId,
      messageId: action.messageId,
      targetType: action.targetType,
      targetHandle: action.targetHandle,
      targetAvatarUrl: action.targetAvatarUrl,
      reason: "not_member",
      availableActions: [...action.availableActions],
      expiresAt: action.expiresAt.toISOString(),
      channelName: action.channelName,
    })),
  };
  return Response.json(body);
}

export const Route = createFileRoute("/api/agent/v1/mention-actions_/pending")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ context: { principal, db } }) =>
        handleAgentMentionPendingGet(principal, {
          pendingMentionActions: (workspaceId, agentId) =>
            pendingMentionActionsForAgent(db, workspaceId, agentId),
        }),
    },
  },
});
