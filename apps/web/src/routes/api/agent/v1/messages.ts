import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { getDatabaseClient } from "#/server/db/client.server";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import { readAgentMessages, searchAgentMessages } from "#/server/agents/agent-messages.service";
import { executeAgentSendMessageWithPolicy } from "#/server/agents/agent-messages.service";
import { SendDirectMessage } from "#/server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "#/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#/server/conversations/conversation-realtime.server";
import { bestEffortMessageNotifier } from "#/server/notifications/web-push-composition.server";

export const Route = createFileRoute("/api/agent/v1/messages")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ request, context }) => {
        const db = getDatabaseClient();
        const agentId = context.principal.agentId;
        if (!db || !agentId)
          return Response.json({ error: "message access denied" }, { status: 403 });
        const query = new URL(request.url).searchParams;
        const repository = new PrismaDirectConversationRepository(db);
        try {
          if (query.has("query")) {
            const messages = await searchAgentMessages(
              repository,
              { workspaceId: context.principal.workspaceId, agentId },
              {
                query: query.get("query") ?? "",
                target: query.get("target") ?? undefined,
                sender: query.get("sender") ?? undefined,
                sort: query.get("sort") === "recent" ? "recent" : "relevance",
                limit: query.has("limit") ? Number(query.get("limit")) : undefined,
                offset: query.has("offset") ? Number(query.get("offset")) : undefined,
              },
            );
            return Response.json({ messages });
          }
          const target = query.get("target");
          if (!target) return Response.json({ error: "target is required" }, { status: 400 });
          const result = await readAgentMessages(
            repository,
            { workspaceId: context.principal.workspaceId, agentId },
            target,
            {
              before: query.get("before") ?? undefined,
              after: query.get("after") ?? undefined,
              around: query.get("around") ?? undefined,
              limit: query.has("limit") ? Number(query.get("limit")) : undefined,
            },
          );
          return Response.json(result);
        } catch {
          return Response.json({ error: "invalid message query" }, { status: 400 });
        }
      },
      POST: async ({ request, context }) => {
        const body = await request.json().catch(() => undefined);
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.target !== "string" ||
          typeof body.body !== "string"
        )
          return Response.json({ error: "target and body are required" }, { status: 400 });
        const db = getDatabaseClient();
        const agentId = context.principal.agentId;
        if (!db || !agentId)
          return Response.json({ error: "message access denied" }, { status: 403 });
        const repository = new PrismaDirectConversationRepository(db);
        const centrifugo = createCentrifugoServerApi();
        const result = await executeAgentSendMessageWithPolicy(
          {
            repository,
            sender: new SendDirectMessage(
              repository,
              getMessageRequestIdempotency(),
              centrifugo,
              new CentrifugoConversationRealtime(centrifugo),
              bestEffortMessageNotifier(db),
            ),
          },
          {
            requestId: typeof body.requestId === "string" ? body.requestId : crypto.randomUUID(),
            workspaceId: context.principal.workspaceId,
            agentId,
            target: body.target,
            body: body.body,
            holdToken: typeof body.holdToken === "string" ? body.holdToken : undefined,
            continueAnyway: body.continueAnyway === true,
            seenUpToSequence:
              typeof body.seenUpToSequence === "number" ? body.seenUpToSequence : undefined,
          },
        );
        return Response.json(result);
      },
    },
  },
});
