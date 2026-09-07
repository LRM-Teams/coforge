import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import {
  issueBrowserRealtimeToken,
  issueConversationRealtimeToken,
} from "../../server/auth/browser-realtime-token.server";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";

export const getBrowserRealtimeConnectionToken = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return issueBrowserRealtimeToken({ userId: user.id, workspaceId });
});

export const getConversationRealtimeToken = createServerFn({ method: "GET" })
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
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
