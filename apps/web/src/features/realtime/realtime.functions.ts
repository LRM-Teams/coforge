import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "#src/lib/app-error";
import {
  issueBrowserRealtimeToken,
  issueConversationRealtimeToken,
  issueUserConversationSubscriptionToken,
  issueWorkspaceConversationSubscriptionToken,
} from "#src/server/auth/browser-realtime-token.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";

export const getBrowserRealtimeConnectionToken = createServerFn({
  method: "GET",
})
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueBrowserRealtimeToken({ userId: user.id, workspaceId });
  });

export const getConversationRealtimeToken = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    const conversation = await db.conversation.findFirst({
      where: {
        id: data.conversationId,
        workspaceId,
        OR: [
          { channelName: null, members: { some: { userId: user.id, ...ACTIVE_MEMBER_WHERE } } },
          {
            channelName: { not: null },
            workspace: { members: { some: { userId: user.id } } },
          },
        ],
      },
      select: { id: true },
    });
    if (!conversation) throw new AppError("ACCESS_DENIED");
    return issueConversationRealtimeToken({
      userId: user.id,
      conversationId: conversation.id,
    });
  });

/** Subscription token for the Workspace-level conversation signal channel (unread badges). */
export const getWorkspaceConversationSubscriptionToken = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueWorkspaceConversationSubscriptionToken({ userId: user.id, workspaceId });
  });

/**
 * Subscription token for the caller's own direct-message signal channel. It is issued for the
 * authenticated user only, so it can never subscribe to another user's DM signals.
 */
export const getUserConversationSubscriptionToken = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    return issueUserConversationSubscriptionToken({ userId: context.user.id });
  });
