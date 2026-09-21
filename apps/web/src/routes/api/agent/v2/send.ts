import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#/server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "#/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#/server/conversations/conversation-realtime.server";
import { bestEffortMessageNotifier } from "#/server/notifications/web-push-composition.server";
import { handleAgentMessagesPost } from "#/routes/api/agent/v1/messages";

/**
 * Raft's versioned send contract: `POST /v2/send` (`agentApiSendV2BodySchema`, 1.0.32 bundle
 * 16728-16744) — the v1 send body plus structured `mentions`, with `idempotencyKey` as the
 * idempotency field (task #58 ④).
 *
 * Served *alongside* `/api/agent/v1/messages`, which stays as it is: a Computer that still speaks
 * v1 must keep sending while it upgrades (the lesson of the dev.53/`content`-rename incident). Both
 * routes share one handler, so the two contracts cannot drift apart in behaviour.
 */
export const Route = createFileRoute("/api/agent/v2/send")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) => {
        const repository = new PrismaDirectConversationRepository(db);
        const centrifugo = createCentrifugoServerApi();
        return handleAgentMessagesPost(request, principal, {
          repository,
          sender: new SendDirectMessage(
            repository,
            getMessageRequestIdempotency(),
            centrifugo,
            new CentrifugoConversationRealtime(centrifugo),
            bestEffortMessageNotifier(db),
          ),
        });
      },
    },
  },
});
