import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import { ReminderNotices } from "../../server/conversations/reminder-notices.server";

const inputSchema = z.object({
  conversationId: z.uuid(),
  threadRootId: z.uuid().optional(),
});

export const loadReminderNotices = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(inputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new ReminderNotices(db).list(
      workspaceId,
      user.id,
      data.conversationId,
      data.threadRootId,
    );
  });
