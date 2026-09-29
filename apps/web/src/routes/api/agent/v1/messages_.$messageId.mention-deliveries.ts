import { createFileRoute } from "@tanstack/react-router";
import type {
  AgentMentionDeliveryErrorResponse,
  AgentMentionDeliveryResponse,
} from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  MentionDeliveryLookup,
  type SenderMentionDeliveries,
} from "#src/server/conversations/mention-deliveries.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";

type AgentScope = { workspaceId: string; agentId: string };

/** `GET /api/agent/v1/messages/:messageId/mention-deliveries` — mention delivery (`coforge mention
 * delivery`): what became of each @mention in a message the calling Agent sent, named by its full
 * id or eight-hex prefix. Any other message is a 404, the same as one that does not exist. */
export async function handleAgentMentionDeliveriesGet(
  principal: AgentScope,
  messageId: string,
  deps: {
    mentionDeliveries(scope: AgentScope, messageId: string): Promise<SenderMentionDeliveries>;
  },
): Promise<Response> {
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  const result = await deps.mentionDeliveries(scope, messageId);
  if (result.state === "found") {
    const body: AgentMentionDeliveryResponse = {
      ok: true,
      messageId: result.messageId,
      deliveries: result.deliveries,
    };
    return Response.json(body);
  }
  const body: AgentMentionDeliveryErrorResponse =
    result.state === "ambiguous"
      ? {
          ok: false,
          errorCode: "ambiguous_message_id",
          error: `More than one message you sent starts with ${messageId}; use its full id.`,
        }
      : {
          ok: false,
          errorCode: "message_not_found",
          error: `You sent no message with id ${messageId}. A message someone else sent is answered the same way.`,
        };
  return Response.json(body, { status: result.state === "ambiguous" ? 400 : 404 });
}

export const Route = createFileRoute("/api/agent/v1/messages_/$messageId/mention-deliveries")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ context: { principal, db }, params }) =>
        handleAgentMentionDeliveriesGet(principal, params.messageId, {
          mentionDeliveries: (scope, messageId) =>
            new MentionDeliveryLookup(new PrismaMentionDeliveryRepository(db)).forSender(
              scope,
              messageId,
            ),
        }),
    },
  },
});
