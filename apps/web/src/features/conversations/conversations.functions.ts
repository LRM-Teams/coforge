import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { SendDirectMessage } from "../../server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "../../server/conversations/redis-message-request-idempotency.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { PrismaDirectConversationRepository } from "../../server/db/repositories/direct-conversation.repositories.server";

const MAX_BODY_LENGTH = 8_000;

function validateAgent(data: unknown) {
  const agentId = data && typeof data === "object" ? Reflect.get(data, "agentId") : undefined;
  if (typeof agentId !== "string" || !agentId) throw new Error("agentId is required");
  return { agentId };
}

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateSend(data: unknown) {
  const { agentId } = validateAgent(data);
  const body = Reflect.get(data as object, "body");
  const requestId = Reflect.get(data as object, "requestId");
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId))
    throw new Error("requestId must be a UUID");
  if (typeof body !== "string") throw new Error("message body must be text");
  const text = body.trim();
  if (!text) throw new Error("message body is required");
  if (text.length > MAX_BODY_LENGTH) throw new Error("message body is too long");
  return { agentId, requestId, body: text };
}

async function context(userId: string, agentId: string) {
  const db = getDatabaseClient();
  if (!db) throw new Error("Conversation persistence is unavailable");
  const membership = await db.workspaceMembership.findFirst({
    where: { userId },
    select: { workspaceId: true },
    orderBy: [{ workspace: { createdAt: "asc" } }, { workspaceId: "asc" }],
  });
  if (!membership) throw new Error("No Workspace membership exists for the authenticated user");
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId: membership.workspaceId, ownerId: userId },
    select: { id: true },
  });
  if (!agent) throw new Error("conversation scope is not authorized");
  const conversations = new PrismaDirectConversationRepository(db);
  const opened = await conversations.openForUser(membership.workspaceId, userId, agentId);
  return { conversations, opened, userId, workspaceId: membership.workspaceId };
}

export const loadDirectConversation = createServerFn({ method: "GET" })
  .validator(validateAgent)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    return (await context(user.id, data.agentId)).opened;
  });

export const sendDirectConversationMessage = createServerFn({ method: "POST" })
  .validator(validateSend)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { conversations, opened, workspaceId } = await context(user.id, data.agentId);
    return new SendDirectMessage(
      conversations,
      getMessageRequestIdempotency(),
      createCentrifugoServerApi(),
    ).execute({
      requestId: data.requestId,
      workspaceId,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: user.id,
      body: data.body,
    });
  });
