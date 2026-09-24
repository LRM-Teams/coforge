import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ActionCards, ActionCardError } from "#src/server/conversations/action-cards.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { isAppError } from "#src/lib/app-error";

export const Route = createFileRoute("/api/agent/v1/actions/prepare")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        const body = await request.json().catch(() => undefined);
        if (!body || typeof body !== "object" || typeof body.target !== "string" || !body.target)
          return Response.json({ error: "target is required" }, { status: 400 });
        const repository = new PrismaDirectConversationRepository(db);
        const centrifugo = createCentrifugoServerApi();
        const actionCards = new ActionCards(
          db,
          repository,
          new CentrifugoConversationRealtime(centrifugo),
        );
        try {
          const result = await actionCards.prepare(
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
          if (isAppError(error))
            return Response.json(
              { error: error.code },
              {
                status:
                  error.code === "ACCESS_DENIED" ? 403 : error.code === "CONFLICT" ? 409 : 422,
              },
            );
          throw error;
        }
      },
    },
  },
});
