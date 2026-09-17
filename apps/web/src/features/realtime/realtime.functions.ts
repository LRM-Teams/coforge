import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import {
  issueBrowserRealtimeToken,
  issueConversationRealtimeToken,
} from "../../server/auth/browser-realtime-token.server";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import { ACTIVE_MEMBER_WHERE } from "../../server/conversations/active-member.server";

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
