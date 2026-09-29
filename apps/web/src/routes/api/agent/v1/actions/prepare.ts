import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  ActionCards,
  ActionCardError,
  parseActionCardAction,
} from "#src/server/conversations/action-cards.server";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { isAppError } from "#src/lib/app-error";
import { postingTargetRefusalResponse } from "#src/server/agents/agent-target-status.server";

export type AgentActionPreparePrincipal = { workspaceId: string; agentId: string };

/** An action-card refusal in the Agent API's refusal shape: the field or the validation issues
 * go into the reason, as the CLI's own validation reports them. */
function actionCardRefusal(error: ActionCardError) {
  const reason = error.issues
    ? `${error.message}: ${error.issues.join("; ")}`
    : error.field
      ? `${error.field}: ${error.message}`
      : error.message;
  return errorResponse(error.code, reason, error.status, false);
}

/**
 * Action-card prepare body handling; extracted from the route so it can be tested directly.
 * `actionCards` is built only once the whole body is valid: building it reaches for Centrifugo,
 * and an invalid body is refused the same way whether or not Centrifugo is configured.
 */
export async function handleAgentActionPrepare(
  request: Request,
  principal: AgentActionPreparePrincipal,
  actionCards: () => Pick<ActionCards, "prepare">,
): Promise<Response> {
  const body = await request.json().catch(() => undefined);
  if (!body || typeof body !== "object" || typeof body.target !== "string" || !body.target)
    return Response.json({ error: "target is required" }, { status: 400 });
  try {
    parseActionCardAction(body.action);
    const result = await actionCards().prepare(
      { workspaceId: principal.workspaceId, agentId: principal.agentId },
      { target: body.target, action: body.action },
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof ActionCardError) return actionCardRefusal(error);
    const refused = postingTargetRefusalResponse(error, body.target);
    if (refused) return refused;
    if (isAppError(error))
      return Response.json(
        { error: error.code },
        {
          status: error.code === "ACCESS_DENIED" ? 403 : error.code === "CONFLICT" ? 409 : 422,
        },
      );
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/actions/prepare")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentActionPrepare(
          request,
          principal,
          () =>
            new ActionCards(
              db,
              new PrismaDirectConversationRepository(db),
              new CentrifugoConversationRealtime(createCentrifugoServerApi()),
            ),
        ),
    },
  },
});
