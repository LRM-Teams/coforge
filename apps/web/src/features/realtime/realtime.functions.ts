import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import {
  issueBrowserRealtimeToken,
  issueConversationRealtimeToken,
} from "../../server/auth/browser-realtime-token.server";
import { browserScope } from "../../server/auth/browser-scope.server";

export const getBrowserRealtimeConnectionToken = createServerFn({
  method: "GET",
}).handler(async () => {
  const { user, workspaceId } = await browserScope();
  return issueBrowserRealtimeToken({ userId: user.id, workspaceId });
});

export const getConversationRealtimeToken = createServerFn({ method: "GET" })
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ data }) => {
    const { user, db, workspaceId } = await browserScope();
    const conversation = await db.conversation.findFirst({
      where: {
        id: data.conversationId,
        workspaceId,
        OR: [
          { channelName: null, members: { some: { userId: user.id } } },
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
