import { createFileRoute } from "@tanstack/react-router";
import {
  AGENT_MENTION_ACTION_MAX_IDS,
  isAgentMentionActionKind,
  type AgentMentionActionErrorResponse,
  type AgentMentionExecuteResponse,
} from "@lrm/coforge-sdk/agent";
import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  notifyAgentMentionTargets,
  refuseAgentMentionAdds,
  type MentionActionResult,
} from "#src/server/conversations/pending-mention-actions.server";

const UUID = UUID_LIKE_PATTERN;

function invalidRequest(error: string): Response {
  const body: AgentMentionActionErrorResponse = { ok: false, errorCode: "invalid_request", error };
  return Response.json(body, { status: 400 });
}

type MentionActionHandler = (
  workspaceId: string,
  agentId: string,
  resolutionIds: readonly string[],
) => Promise<MentionActionResult[]>;

/** `POST /api/agent/v1/mention-actions/execute` — `coforge mention notify|add <resolutionIds...>`.
 * `notify` reaches each target without making it a member. Adding a member is a human's decision,
 * so an Agent's `add` is refused for each of its own pending mentions; an id that is not the
 * Agent's is `not_found` either way. */
export async function handleAgentMentionExecutePost(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  deps: {
    notifyAgentMentionTargets: MentionActionHandler;
    refuseAgentMentionAdds: MentionActionHandler;
  },
): Promise<Response> {
  const body = (await request.json().catch(() => undefined)) as
    | { action?: unknown; resolutionIds?: unknown }
    | undefined;
  if (!body || typeof body !== "object") return invalidRequest("The request body must be JSON.");
  const action = body.action;
  if (!isAgentMentionActionKind(action)) return invalidRequest('action must be "notify" or "add".');
  const ids = body.resolutionIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > AGENT_MENTION_ACTION_MAX_IDS ||
    ids.some((id) => typeof id !== "string" || !UUID.test(id))
  )
    return invalidRequest(
      `resolutionIds must list 1 to ${AGENT_MENTION_ACTION_MAX_IDS} resolution ids (UUIDs).`,
    );
  const run = action === "notify" ? deps.notifyAgentMentionTargets : deps.refuseAgentMentionAdds;
  const results = await run(principal.workspaceId, principal.agentId, ids as string[]);
  const response: AgentMentionExecuteResponse = { ok: true, action, results };
  return Response.json(response);
}

export const Route = createFileRoute("/api/agent/v1/mention-actions_/execute")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentMentionExecutePost(request, principal, {
          notifyAgentMentionTargets: (workspaceId, agentId, resolutionIds) =>
            notifyAgentMentionTargets(db, workspaceId, agentId, resolutionIds),
          refuseAgentMentionAdds: (workspaceId, agentId, resolutionIds) =>
            refuseAgentMentionAdds(db, workspaceId, agentId, resolutionIds),
        }),
    },
  },
});
