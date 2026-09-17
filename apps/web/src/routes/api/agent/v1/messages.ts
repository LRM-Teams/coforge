import { createFileRoute } from "@tanstack/react-router";
import type { AgentHistoryResponse, AgentSendResponse, AgentMessage } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  readAgentMessages,
  executeAgentSendMessageWithPolicy,
  type AgentMessageRepository,
  type AgentSendMessageResult,
} from "#/server/agents/agent-messages.service";
import { SendDirectMessage } from "#/server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "#/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#/server/conversations/conversation-realtime.server";
import { bestEffortMessageNotifier } from "#/server/notifications/web-push-composition.server";
import { isAppError } from "#/lib/app-error";

export type AgentMessagesGetPrincipal = { workspaceId: string; agentId: string };

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

/** Read-only history route; `query` belongs to the dedicated search route. */
export async function handleAgentMessagesGet(
  request: Request,
  principal: AgentMessagesGetPrincipal,
  repository: AgentMessageRepository,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const requestId = query.get("requestId") || crypto.randomUUID();
  const scope = { workspaceId: principal.workspaceId, agentId: principal.agentId };
  try {
    if (query.has("query"))
      return Response.json(
        { error: "use /api/agent/v1/messages/search for query" },
        { status: 400 },
      );
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
    const messages = result.messages as AgentMessage[];
    const response: AgentHistoryResponse = {
      protocolMajor: 1,
      requestId,
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

/** Maps `executeAgentSendMessageWithPolicy`'s side-effect decision onto the send route's `state`. */
function mapSendResult(requestId: string, result: AgentSendMessageResult & { messages: unknown }) {
  const context = (result.messages as { createdAt: Date }[]).map((message) => ({
    ...message,
    createdAt: message.createdAt.toISOString(),
  })) as AgentMessage[];
  const response: AgentSendResponse = {
    protocolMajor: 1,
    requestId,
    state:
      result.sideEffectDecision === "hold"
        ? "held"
        : result.sideEffectDecision === "anyway_denied"
          ? "denied"
          : "sent",
    messageId: result.messageId,
    holdToken: result.holdToken,
    bypass: result.sideEffectDecision === "anyway_accepted" ? true : undefined,
    anywayAllowed: result.anywayAllowed,
    // Belt and braces: never surface message bodies for a withheld hold, even
    // if the service's own `messages` field were ever non-empty.
    context: result.freshnessContextMode === "withheld" ? [] : context,
    freshnessContextMode: result.freshnessContextMode,
    withheldMessageCount: result.withheldMessageCount,
  };
  return response;
}

export type AgentMessagesPostPrincipal = { workspaceId: string; agentId: string };

/** Send-route body handling; extracted from the route so it can be tested with fakes. */
export async function handleAgentMessagesPost(
  request: Request,
  principal: AgentMessagesPostPrincipal,
  dependencies: Parameters<typeof executeAgentSendMessageWithPolicy>[0],
): Promise<Response> {
  const body = await request.json().catch(() => undefined);
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.target !== "string" ||
    typeof body.body !== "string"
  )
    return Response.json({ error: "target and body are required" }, { status: 400 });
  const freshnessContextMode = body.freshnessContextMode;
  if (
    freshnessContextMode !== undefined &&
    freshnessContextMode !== "inline" &&
    freshnessContextMode !== "withheld"
  )
    return Response.json({ error: "invalid freshnessContextMode" }, { status: 400 });
  const requestId = typeof body.requestId === "string" ? body.requestId : crypto.randomUUID();
  try {
    const result = await executeAgentSendMessageWithPolicy(dependencies, {
      requestId,
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      target: body.target,
      body: body.body,
      holdToken: typeof body.holdToken === "string" ? body.holdToken : undefined,
      continueAnyway: body.continueAnyway === true,
      seenUpToSequence:
        typeof body.seenUpToSequence === "number" ? body.seenUpToSequence : undefined,
      freshnessContextMode,
    });
    return Response.json(mapSendResult(requestId, result));
  } catch (error) {
    if (isAppError(error) && error.code === "CONFLICT")
      return new Response("channel is archived", { status: 409 });
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/messages")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentMessagesGet(request, principal, new PrismaDirectConversationRepository(db)),
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
