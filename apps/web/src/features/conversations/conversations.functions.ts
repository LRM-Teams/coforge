import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  agentConversationInputSchema,
  readConversationThreadInputSchema,
  sendConversationMessageInputSchema,
} from "./conversation.schemas";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { SendDirectMessage } from "../../server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "../../server/conversations/redis-message-request-idempotency.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { PrismaDirectConversationRepository } from "../../server/db/repositories/direct-conversation.repositories.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { withMessageSendTrace } from "../../server/observability/tracing.server";
import { bestEffortMessageNotifier } from "../../server/notifications/web-push-composition.server";

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
  const opened = await conversations.openForUser(workspaceId, user.id, agentId);
  return {
    conversations,
    opened,
    userId: user.id,
    workspaceId,
    notifications: bestEffortMessageNotifier(db),
  };
}

export const loadDirectConversation = createServerFn({ method: "GET" })
  .validator(agentConversationInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    return (await context(user, data.agentId)).opened;
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
        const { conversations, opened, workspaceId, notifications } = await sendTrace.measure(
          "message.context",
          () => context(user, data.agentId),
        );
        return sendTrace.measure("message.persist_and_publish", () =>
          new SendDirectMessage(
            conversations,
            getMessageRequestIdempotency(),
            createCentrifugoServerApi(),
            notifications,
          ).execute({
            requestId: data.requestId,
            workspaceId,
            conversationId: opened.conversationId,
            senderMemberId: opened.senderMemberId,
            senderUserId: user.id,
            body: data.body,
            attachmentId: data.attachmentId,
            threadRootId: data.threadRootId,
          }),
        );
      },
    );
  });
