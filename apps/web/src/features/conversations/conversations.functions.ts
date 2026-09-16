import { createServerFn } from "@tanstack/react-start";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "../../server/auth/function-auth";
import {
  agentConversationPageInputSchema,
  agentConversationUpdatesInputSchema,
  conversationAroundInputSchema,
  ownMessageIndexInputSchema,
  readConversationThreadInputSchema,
  sendConversationMessageInputSchema,
} from "./conversation.schemas";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { SendDirectMessage } from "../../server/conversations/direct-message.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { ConversationHistory } from "../../server/conversations/conversation-history.server";
import { getMessageRequestIdempotency } from "../../server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "../../server/db/repositories/direct-conversation.repositories.server";
import { withMessageSendTrace } from "../../server/observability/tracing.server";
import { workspaceUserAvatarUrl } from "../../server/db/repositories/user-profile.repositories.server";

/** The caller's own direct conversation repository, or a failure when the Agent is not theirs. */
async function ownedConversations(
  { db, workspaceId, user }: WorkspaceUserContext,
  agentId: string,
) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, ownerId: user.id },
    select: { id: true },
  });
  if (!agent) throw new Error("conversation scope is not authorized");
  return new PrismaDirectConversationRepository(db);
}

export const loadDirectConversation = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentConversationPageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, workspaceId } = context;
    const conversations = await ownedConversations(context, data.agentId);
    return conversations.openForUser(workspaceId, user.id, data.agentId, {
      beforeSequence: data.beforeSequence,
    });
  });

export const loadDirectConversationUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentConversationUpdatesInputSchema)
  .handler(async ({ context, data }) => {
    const { user, workspaceId } = context;
    const conversations = await ownedConversations(context, data.agentId);
    return conversations.updatesForUser(workspaceId, user.id, data.agentId, data.afterSequence);
  });

export const loadOwnConversationMessages = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(ownMessageIndexInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    return new ConversationHistory(db).listOwnMessages(workspaceId, user.id, data.conversationId, {
      beforeSequence: data.beforeSequence,
    });
  });

export const loadConversationAround = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(conversationAroundInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    return new ConversationHistory(db).loadAround(
      workspaceId,
      user.id,
      data.conversationId,
      data.messageId,
    );
  });

export const markDirectThreadRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(readConversationThreadInputSchema)
  .handler(async ({ context, data }) => {
    const { user, workspaceId } = context;
    const conversations = await ownedConversations(context, data.agentId);
    await conversations.markThreadReadForUser(
      workspaceId,
      user.id,
      data.agentId,
      data.threadRootId,
      data.throughSequence,
    );
  });

export const sendDirectConversationMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(sendConversationMessageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return withMessageSendTrace(
      data.requestId,
      { "coforge.agent_id": data.agentId },
      async (sendTrace) => {
        const conversations = await sendTrace.measure("message.context", () =>
          ownedConversations(context, data.agentId),
        );
        const opened = await conversations.memberForUser(workspaceId, user.id, data.agentId);
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
        const profile = await db.user.findUnique({
          where: { id: user.id },
          select: { avatarObjectKey: true },
        });
        return {
          id: message.id,
          sequence: message.sequence,
          threadRootId: data.threadRootId,
          senderKind: "user" as const,
          senderMemberId: opened.senderMemberId,
          senderName: `@${user.username}`,
          senderAvatarUrl: workspaceUserAvatarUrl(
            workspaceId,
            user.id,
            profile?.avatarObjectKey ?? null,
          ),
          body: message.body,
          createdAt: message.createdAt,
          attachment: message.attachment,
          reactions: undefined,
        };
      },
    );
  });
