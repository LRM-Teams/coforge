import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  agentConversationPageInputSchema,
  agentConversationUpdatesInputSchema,
  conversationAroundInputSchema,
  ownMessageIndexInputSchema,
  readConversationThreadInputSchema,
  sendConversationMessageInputSchema,
} from "./conversation.schemas";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { SendDirectMessage } from "../../server/conversations/direct-message.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { ConversationHistory } from "../../server/conversations/conversation-history.server";
import { getMessageRequestIdempotency } from "../../server/conversations/redis-message-request-idempotency.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { PrismaDirectConversationRepository } from "../../server/db/repositories/direct-conversation.repositories.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { withMessageSendTrace } from "../../server/observability/tracing.server";

async function context(user: { id: string; username: string; name: string }, agentId: string) {
  const db = getDatabaseClient();
  if (!db) throw new Error("Conversation persistence is unavailable");
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, ownerId: user.id },
    select: { id: true },
  });
  if (!agent) throw new Error("conversation scope is not authorized");
  const conversations = new PrismaDirectConversationRepository(db);
  return { conversations, userId: user.id, workspaceId };
}

async function historyContext(userId: string) {
  const db = getDatabaseClient();
  if (!db) throw new Error("Conversation persistence is unavailable");
  const workspaceId = await requireWorkspaceIdForRequest(db, userId);
  return { history: new ConversationHistory(db), workspaceId };
}

export const loadDirectConversation = createServerFn({ method: "GET" })
  .validator(agentConversationPageInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { conversations, workspaceId } = await context(user, data.agentId);
    return conversations.openForUser(workspaceId, user.id, data.agentId, {
      beforeSequence: data.beforeSequence,
    });
  });

export const loadDirectConversationUpdates = createServerFn({ method: "GET" })
  .validator(agentConversationUpdatesInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { conversations, workspaceId } = await context(user, data.agentId);
    return conversations.updatesForUser(workspaceId, user.id, data.agentId, data.afterSequence);
  });

export const loadOwnConversationMessages = createServerFn({ method: "GET" })
  .validator(ownMessageIndexInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { history, workspaceId } = await historyContext(user.id);
    return history.listOwnMessages(workspaceId, user.id, data.conversationId, {
      beforeSequence: data.beforeSequence,
    });
  });

export const loadConversationAround = createServerFn({ method: "GET" })
  .validator(conversationAroundInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { history, workspaceId } = await historyContext(user.id);
    return history.loadAround(workspaceId, user.id, data.conversationId, data.messageId);
  });

export const markDirectThreadRead = createServerFn({ method: "POST" })
  .validator(readConversationThreadInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { conversations, workspaceId } = await context(user, data.agentId);
    await conversations.markThreadReadForUser(
      workspaceId,
      user.id,
      data.agentId,
      data.threadRootId,
      data.throughSequence,
    );
  });

export const sendDirectConversationMessage = createServerFn({ method: "POST" })
  .validator(sendConversationMessageInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    return withMessageSendTrace(
      data.requestId,
      { "coforge.agent_id": data.agentId },
      async (sendTrace) => {
        const { conversations, workspaceId } = await sendTrace.measure("message.context", () =>
          context(user, data.agentId),
        );
        const opened = await conversations.openForUser(workspaceId, user.id, data.agentId);
        const message = await sendTrace.measure("message.persist_and_publish", () => {
          const centrifugo = createCentrifugoServerApi();
          return new SendDirectMessage(
            conversations,
            getMessageRequestIdempotency(),
            centrifugo,
            new CentrifugoConversationRealtime(centrifugo),
          ).execute({
            requestId: data.requestId,
            workspaceId,
            conversationId: opened.conversationId,
            senderMemberId: opened.senderMemberId,
            senderUserId: user.id,
            body: data.body,
            attachmentId: data.attachmentId,
            threadRootId: data.threadRootId,
          });
        });
        return {
          id: message.id,
          sequence: message.sequence,
          threadRootId: data.threadRootId,
          senderKind: "user" as const,
          senderMemberId: opened.senderMemberId,
          senderName: `@${user.username}`,
          body: message.body,
          createdAt: message.createdAt,
          attachment: message.attachment,
        };
      },
    );
  });
