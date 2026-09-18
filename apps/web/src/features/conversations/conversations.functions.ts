import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "../../server/auth/function-auth";
import { ACTIVE_AGENT_WHERE } from "../../server/agents/active-agent.server";
import {
  agentConversationInputSchema,
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
import { attachActionCardViews } from "../../server/conversations/action-cards.server";
import { getMessageRequestIdempotency } from "../../server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "../../server/db/repositories/direct-conversation.repositories.server";
import { withMessageSendTrace } from "../../server/observability/tracing.server";
import { workspaceUserAvatarUrl } from "../../server/db/repositories/user-profile.repositories.server";

/**
 * The caller's own direct conversation repository, or a failure when the Agent is not theirs.
 * `canSend` distinguishes writing from reading: a deleted Agent's DM stays readable (ADR 0044
 * keeps its history, rendered with a `DELETED` sender), but no new message may be sent to it.
 */
async function ownedConversations(
  { db, workspaceId, user }: WorkspaceUserContext,
  agentId: string,
  options: { canSend?: boolean } = {},
) {
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId,
      ownerId: user.id,
      ...(options.canSend ? ACTIVE_AGENT_WHERE : {}),
    },
    select: { id: true },
  });
  if (!agent) throw new Error("conversation scope is not authorized");
  return new PrismaDirectConversationRepository(db);
}

export const loadDirectConversation = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentConversationPageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const conversations = await ownedConversations(context, data.agentId);
    const page = await conversations.openForUser(workspaceId, user.id, data.agentId, {
      beforeSequence: data.beforeSequence,
    });
    return {
      ...page,
      messages: await attachActionCardViews(db, workspaceId, user.id, page.messages),
    };
  });

export const loadDirectConversationUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentConversationUpdatesInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const conversations = await ownedConversations(context, data.agentId);
    const messages = await conversations.updatesForUser(
      workspaceId,
      user.id,
      data.agentId,
      data.afterSequence,
    );
    return attachActionCardViews(db, workspaceId, user.id, messages);
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
    const page = await new ConversationHistory(db).loadAround(
      workspaceId,
      user.id,
      data.conversationId,
      data.messageId,
    );
    return {
      ...page,
      messages: await attachActionCardViews(db, workspaceId, user.id, page.messages),
    };
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

/** Per-DM unread for the sidebar, keyed by the Agent row that owns each badge — the same key
 * the realtime publication carries, so no conversation→Agent alias map is needed (ADR 0046). */
export type DirectConversationUnread = Record<string, number>;

export type DirectConversationBadges = {
  /** The signed-in user's id, for their own direct-message signal channel. */
  viewerId: string;
  /** Unread counts keyed by the Agent whose sidebar row owns the badge. */
  unread: DirectConversationUnread;
};

/**
 * Everything the Chat sidebar needs about direct messages in one round trip: the viewer's own
 * id (their personal signal channel) and the per-Agent unread counts seeded into the badges.
 */
export const loadDirectConversationBadges = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }): Promise<DirectConversationBadges> => {
    const { user, db, workspaceId } = context;
    const rows =
      (await new PrismaDirectConversationRepository(db).unreadCountsForUser?.(
        workspaceId,
        user.id,
      )) ?? [];
    const unread: DirectConversationUnread = {};
    for (const row of rows) unread[row.agentId] = row.unread;
    return { viewerId: user.id, unread };
  });

/** Advances the DM read cursor for the sidebar badge; monotone and clamped (ADR 0046). */
export const markDirectConversationRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentConversationInputSchema.extend({ throughSequence: z.number().int().positive() }))
  .handler(async ({ context, data }) => {
    const { user, workspaceId } = context;
    const conversations = await ownedConversations(context, data.agentId);
    await conversations.markReadForUser?.(workspaceId, user.id, data.agentId, data.throughSequence);
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
          ownedConversations(context, data.agentId, { canSend: true }),
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
            attachmentIds: data.attachmentIds,
            threadRootId: data.threadRootId,
          });
        });
        const profile = await db.user.findUnique({
          where: { id: user.id },
          select: { displayName: true, avatarObjectKey: true },
        });
        return {
          id: message.id,
          sequence: message.sequence,
          threadRootId: data.threadRootId,
          senderKind: "user" as const,
          senderMemberId: opened.senderMemberId,
          // Reads exactly like the same message after a reload: display name, handle separately.
          senderName: profile?.displayName?.trim() || user.username,
          senderHandle: user.username,
          // A human-sent echo never carries an Agent id, and a human sender is never deleted.
          senderAgentId: undefined,
          senderDeleted: false,
          senderAvatarUrl: workspaceUserAvatarUrl(
            workspaceId,
            user.id,
            profile?.avatarObjectKey ?? null,
          ),
          body: message.body,
          createdAt: message.createdAt,
          // DMs carry no mention structure; only channel bodies are normalized to token form.
          mentions: [],
          attachments: message.attachments,
          reactions: undefined,
          // A human-sent message never carries an action card (those are Agent-authored only).
          actionCard: undefined,
        };
      },
    );
  });
