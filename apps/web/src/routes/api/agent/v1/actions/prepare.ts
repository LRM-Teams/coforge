import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ActionCards, ActionCardError } from "#src/server/conversations/action-cards.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { isAppError } from "#src/lib/app-error";
import { postingTargetRefusalResponse } from "#src/server/agents/agent-target-status.server";

export type AgentActionPreparePrincipal = { workspaceId: string; agentId: string };

/**
 * Action-card prepare body handling; extracted from the route so it can be tested directly.
 * `actionCards` is built only once the body is valid: building it reaches for Centrifugo, and an
 * invalid body is a 400 whether or not Centrifugo is configured.
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
    const result = await actionCards().prepare(
      { workspaceId: principal.workspaceId, agentId: principal.agentId },
      { target: body.target, action: body.action },
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof ActionCardError)
      return Response.json(
        {
          error: error.code,
          ...(error.field ? { field: error.field } : {}),
          ...(error.issues ? { issues: error.issues } : {}),
          message: error.message,
        },
        { status: error.status },
      );
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
