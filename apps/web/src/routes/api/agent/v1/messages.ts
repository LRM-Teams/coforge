import { createFileRoute } from "@tanstack/react-router";
import type { AgentHistoryResponse, AgentSendResponse, AgentMessage } from "@lrm/coforge-sdk/agent";
import { isValidMentionSelectorArray } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaDirectConversationRepository } from "#/server/db/repositories/direct-conversation.repositories.server";
import {
  readAgentMessages,
  executeAgentSendMessageWithPolicy,
  type AgentMentionSelector,
  type AgentMessageRepository,
  type AgentSendMessageResult,
} from "#/server/agents/agent-messages.service";
import { SendDirectMessage } from "#/server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "#/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#/server/conversations/conversation-realtime.server";
import { bestEffortMessageNotifier } from "#/server/notifications/web-push-composition.server";
import { isAppError } from "#/lib/app-error";
import { AgentSendRejectedError } from "#/server/conversations/agent-send-rejected-error.server";

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

/** Maps `executeAgentSendMessageWithPolicy`'s side-effect decision onto the send route's response,
 * using Raft's own field names for both states (`agentApiSendResponseSchema`). */
function mapSendResult(requestId: string, result: AgentSendMessageResult) {
  const toAgentMessage = (message: { createdAt: Date }) =>
    ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    }) as AgentMessage;
  const response: AgentSendResponse = {
    protocolMajor: 1,
    requestId,
    state: result.state,
    decision: result.decision,
    reason: result.reason,
    producerFactId: result.producerFactId,
    messageId: result.messageId,
    availableActions: result.availableActions ? [...result.availableActions] : undefined,
    continueAnywaySuggested: result.continueAnywaySuggested,
    // Held-context fields are only ever present on a held result; a sent one carries none.
    heldMessages:
      result.state === "held" ? (result.heldMessages ?? []).map(toAgentMessage) : undefined,
    newMessageCount: result.newMessageCount,
    shownMessageCount: result.shownMessageCount,
    omittedMessageCount: result.omittedMessageCount,
    seenUpToSeq: result.state === "held" ? result.seenUpToSeq : undefined,
    freshnessContextMode: result.freshnessContextMode,
    withheldMessageCount: result.withheldMessageCount,
    recentUnread: (result.recentUnread ?? []).map(toAgentMessage),
  };
  return response;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_IDS_MAX_LENGTH = 10;

/** Shape-only validation for `attachmentIds`: an array of at most 10 unique UUIDs. Deeper
 * per-id ownership/existence checks happen in the repository's own send transaction. */
function isValidAttachmentIdsArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > ATTACHMENT_IDS_MAX_LENGTH) return false;
  if (!value.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) return false;
  return new Set(value).size === value.length;
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
    typeof body.content !== "string"
  )
    return Response.json({ error: "target and content are required" }, { status: 400 });
  const freshnessContextMode = body.freshnessContextMode;
  if (
    freshnessContextMode !== undefined &&
    freshnessContextMode !== "inline" &&
    freshnessContextMode !== "withheld"
  )
    return Response.json({ error: "invalid freshnessContextMode" }, { status: 400 });
  if (body.attachmentIds !== undefined && !isValidAttachmentIdsArray(body.attachmentIds))
    return Response.json({ error: "invalid attachmentIds" }, { status: 400 });
  if (body.mentions !== undefined && !isValidMentionSelectorArray(body.mentions))
    return Response.json({ error: "invalid mentions" }, { status: 400 });
  const requestId = typeof body.requestId === "string" ? body.requestId : crypto.randomUUID();
  try {
    const result = await executeAgentSendMessageWithPolicy(dependencies, {
      requestId,
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      target: body.target,
      content: body.content,
      continueAnyway: body.continueAnyway === true,
      draftReholdCount:
        typeof body.draftReholdCount === "number" && Number.isInteger(body.draftReholdCount)
          ? body.draftReholdCount
          : undefined,
      draftReplacedExisting: body.draftReplacedExisting === true,
      seenUpToSeq: typeof body.seenUpToSeq === "number" ? body.seenUpToSeq : undefined,
      freshnessContextMode,
      attachmentIds: Array.isArray(body.attachmentIds)
        ? (body.attachmentIds as string[])
        : undefined,
      mentions: body.mentions as AgentMentionSelector[] | undefined,
    });
    return Response.json(mapSendResult(requestId, result));
  } catch (error) {
    // Only this send-specific class is mapped here; every other error (including any AppError
    // raised elsewhere, e.g. getAgentChannel's ACCESS_DENIED for a non-member) propagates
    // unchanged, exactly as it did before this class existed.
    if (error instanceof AgentSendRejectedError)
      return Response.json({ error: error.message }, { status: error.status });
    // An archived channel refuses posting (AppError("CONFLICT") from PublicChannels.send /
    // sendAgentMessage); reported the same way the rest of this route family reports a plain
    // text failure.
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
