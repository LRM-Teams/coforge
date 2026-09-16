import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import {
  issueBrowserRealtimeToken,
  issueConversationRealtimeToken,
} from "../../server/auth/browser-realtime-token.server";
import { authMiddleware } from "../../server/auth/function-auth";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";

export const getBrowserRealtimeConnectionToken = createServerFn({
  method: "GET",
})
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const db = getDatabaseClient();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    return issueBrowserRealtimeToken({ userId: user.id, workspaceId });
  });

export const getConversationRealtimeToken = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const user = context.user;
    const db = getDatabaseClient();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);

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
