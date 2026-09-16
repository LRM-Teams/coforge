import { createFileRoute } from "@tanstack/react-router";
import type { CloudAgentMessageResponse } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "../../../../../generated/client";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { getDatabaseClient } from "#/server/db/client.server";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  readAgentMessages,
  searchAgentMessages,
  type AgentMessageRepository,
} from "#/server/agents/agent-messages.service";
import { executeAgentSendMessageWithPolicy } from "#/server/agents/agent-messages.service";
import { SendDirectMessage } from "#/server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "#/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#/server/conversations/conversation-realtime.server";
import { bestEffortMessageNotifier } from "#/server/notifications/web-push-composition.server";

export type AgentMessagesGetPrincipal = { workspaceId: string; agentId?: string };

export type AgentMessagesGetDependencies = {
  database(): PrismaClient | null | undefined;
  createRepository(db: PrismaClient): AgentMessageRepository;
};

const agentMessagesGetDependencies: AgentMessagesGetDependencies = {
  database: getDatabaseClient,
  createRepository: (db) => new PrismaDirectConversationRepository(db),
};

/** Parses a sequence-window query param, throwing on a non-integer value. */
function parseSequenceParam(
  query: URLSearchParams,
  key: "fromSequence" | "throughSequence",
): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`invalid ${key}`);
  return value;
}

export async function handleAgentMessagesGet(
  request: Request,
  principal: AgentMessagesGetPrincipal,
  dependencies: AgentMessagesGetDependencies = agentMessagesGetDependencies,
): Promise<Response> {
  const db = dependencies.database();
  const agentId = principal.agentId;
  if (!db || !agentId) return Response.json({ error: "message access denied" }, { status: 403 });
  const query = new URL(request.url).searchParams;
  const requestId = query.get("requestId") || crypto.randomUUID();
  const repository = dependencies.createRepository(db);
  const scope = { workspaceId: principal.workspaceId, agentId };
  try {
    if (query.has("query")) {
      const messages = await searchAgentMessages(repository, scope, {
        query: query.get("query") ?? "",
        target: query.get("target") ?? undefined,
        sender: query.get("sender") ?? undefined,
        sort: query.get("sort") === "recent" ? "recent" : "relevance",
        limit: query.has("limit") ? Number(query.get("limit")) : undefined,
        offset: query.has("offset") ? Number(query.get("offset")) : undefined,
      });
      const response: CloudAgentMessageResponse = {
        protocolMajor: 1,
        requestId,
        accepted: true,
        attentionCount: 0,
        messages,
      };
      return Response.json(response);
    }
    const target = query.get("target");
    if (!target) return Response.json({ error: "target is required" }, { status: 400 });
    const fromSequence = parseSequenceParam(query, "fromSequence");
    const throughSequence = parseSequenceParam(query, "throughSequence");
    const result = await readAgentMessages(repository, scope, target, {
      before: query.get("before") ?? undefined,
      after: query.get("after") ?? undefined,
      around: query.get("around") ?? undefined,
      limit: query.has("limit") ? Number(query.get("limit")) : undefined,
      fromSequence,
      throughSequence,
    });
    const messages = result.messages;
    const response: CloudAgentMessageResponse = {
      protocolMajor: 1,
      requestId,
      accepted: true,
      attentionCount: 0,
      messages,
      hasOlder: result.hasOlder,
      hasNewer: result.hasNewer,
      olderCursor: messages[0]?.id,
      newerCursor: messages.at(-1)?.id,
    };
    return Response.json(response);
  } catch {
    return Response.json({ error: "invalid message query" }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/agent/v1/messages")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context }) => handleAgentMessagesGet(request, context.principal),
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
