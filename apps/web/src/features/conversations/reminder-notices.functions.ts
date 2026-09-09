import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { ReminderNotices } from "../../server/conversations/reminder-notices.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";

const inputSchema = z.object({
  conversationId: z.uuid(),
  threadRootId: z.uuid().optional(),
});

export const loadReminderNotices = createServerFn({ method: "GET" })
  .validator(inputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Conversation persistence is unavailable");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    return new ReminderNotices(db).list(
      workspaceId,
      user.id,
      data.conversationId,
      data.threadRootId,
    );
  });
