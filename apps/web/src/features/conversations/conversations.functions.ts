import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  conversationAroundInputSchema,
  directConversationInputSchema,
  directConversationPageInputSchema,
  directConversationUpdatesInputSchema,
  ownMessageIndexInputSchema,
  readConversationThreadInputSchema,
  sendConversationMessageInputSchema,
  toggleMessageReactionInputSchema,
} from "./conversation.schemas";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { attachActionCardViews } from "#src/server/conversations/action-cards.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { withMessageSendTrace } from "#src/server/observability/tracing.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

/** The viewer's direct conversation with an Agent or a member, started on first open. */
export const openDirectConversation = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.union([z.object({ agentId: z.uuid() }), z.object({ userId: z.uuid() })]))
  .handler(({ data, context }) =>
    new DirectConversations(context.db).open(context.workspaceId, context.user.id, data),
  );

export const loadDirectConversation = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationPageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const page = await new DirectConversations(db).page(workspaceId, user.id, data.conversationId, {
      beforeSequence: data.beforeSequence,
      afterSequence: data.afterSequence,
      limit: data.limit,
    });
    return {
      ...page,
      messages: await attachActionCardViews(db, workspaceId, user.id, page.messages),
    };
  });

export const loadDirectConversationUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationUpdatesInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const messages = await new DirectConversations(db).updates(
      workspaceId,
      user.id,
      data.conversationId,
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
      viewerHandle: user.username,
      ...page,
      messages: await attachActionCardViews(db, workspaceId, user.id, page.messages),
    };
  });

export const markDirectThreadRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(readConversationThreadInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    await new DirectConversations(db).markThreadRead(
      workspaceId,
      user.id,
      data.conversationId,
      data.threadRootId,
      data.throughSequence,
    );
  });

/** Per-DM unread for the sidebar, by conversation id: the key a DM's realtime signal carries
 * too, for a DM with an Agent and one between members alike. */
export type DirectConversationUnread = Record<string, number>;

export type DirectConversationBadges = {
  /** The signed-in user's id, for their own direct-message signal channel. */
  viewerId: string;
  /** Unread counts by conversation id. */
  unread: DirectConversationUnread;
};

/**
 * Everything the Chat sidebar needs about direct-message badges in one round trip: the viewer's
 * own id (their personal signal channel) and the unread counts seeded into the badges.
 */
export const loadDirectConversationBadges = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }): Promise<DirectConversationBadges> => {
    const { user, db, workspaceId } = context;
    const rows = await new DirectConversations(db).unreadCounts(workspaceId, user.id);
    const unread: DirectConversationUnread = {};
    for (const row of rows) unread[row.conversationId] = row.unread;
    return { viewerId: user.id, unread };
  });

/** Advances the DM read cursor for the sidebar badge; monotone and clamped. */
export const markDirectConversationRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ throughSequence: z.number().int().positive() }))
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    await new DirectConversations(db).markRead(
      workspaceId,
      user.id,
      data.conversationId,
      data.throughSequence,
    );
  });

/** Pins the viewer's DM after their other pins, or unpins it (#121). */
export const setDirectConversationPinned = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ pinned: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setPinned(workspaceId, user.id, data.conversationId, data.pinned),
  );

/** Marks the viewer's DM unread, or clears the marker (#122). */
export const setDirectConversationUnread = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ unread: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setUnread(workspaceId, user.id, data.conversationId, data.unread),
  );

/** Closes the viewer's DM in their list only, or brings it back (#122). */
export const setDirectConversationHidden = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ hidden: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setHidden(workspaceId, user.id, data.conversationId, data.hidden),
  );

/**
 * The sidebar's Direct messages, by conversation id: the viewer's DMs (the sidebar lists only
 * these) and who each is with, which are pinned (with their order) and which are closed.
 */
export const loadDirectConversationPreferences = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { user, db, workspaceId } }) =>
    new DirectConversations(db).list(workspaceId, user.id),
  );

export const sendDirectConversationMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(sendConversationMessageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return withMessageSendTrace(
      data.requestId,
      { "coforge.conversation_id": data.conversationId },
      async (sendTrace) => {
        const centrifugo = createCentrifugoServerApi();
        // The echo's sender profile does not depend on the send.
        const [message, profile] = await Promise.all([
          sendTrace.measure("message.persist_and_publish", () =>
            new DirectConversations(db).send(
              workspaceId,
              user.id,
              data.conversationId,
              {
                requestId: data.requestId,
                body: data.body,
                attachmentIds: data.attachmentIds,
                threadRootId: data.threadRootId,
              },
              {
                idempotency: getMessageRequestIdempotency(),
                centrifugo,
                realtime: new CentrifugoConversationRealtime(centrifugo),
              },
            ),
          ),
          db.user.findUnique({
            where: { id: user.id },
            select: { displayName: true, avatarObjectKey: true },
          }),
        ]);
        return {
          id: message.id,
          sequence: message.sequence,
          threadRootId: data.threadRootId,
          senderKind: "user" as const,
          senderMemberId: message.senderMemberId,
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

/** The viewer's own emoji reaction on a DM message; returns the message's fresh summaries. */
export const toggleDirectMessageReaction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend(toggleMessageReactionInputSchema.shape))
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const { conversationId, ...reaction } = data;
    return new DirectConversations(db).react(workspaceId, user.id, conversationId, reaction);
  });
