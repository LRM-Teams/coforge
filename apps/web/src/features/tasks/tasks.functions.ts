import { TASK_STATUSES, type TaskCommand } from "@coforge/protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { AppError } from "../../lib/app-error";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { bestEffortMessageNotifier } from "../../server/notifications/web-push-composition.server";
import { TaskBoard } from "../../server/tasks/task-board.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";

const taskCommand = z
  .object({
    operation: z.enum(["list", "create", "convert", "claim", "unclaim", "update"]),
    requestId: z.uuid(),
    conversationId: z.uuid(),
    target: z.never().optional(),
    number: z.number().int().positive().optional(),
    messageId: z.string().min(8).max(36).optional(),
    title: z.string().trim().min(1).max(8_000).optional(),
    attachmentId: z.uuid().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const loadTaskOverview = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return new TaskBoard(db).overview(workspaceId, user.id);
});

export const executeTask = createServerFn({ method: "POST" })
  .validator((data: unknown): TaskCommand => taskCommand.parse(data))
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    const centrifugo = createCentrifugoServerApi();
    return new TaskBoard(db, {
      notifications: bestEffortMessageNotifier(db),
      realtime: new CentrifugoConversationRealtime(centrifugo),
      publisher: centrifugo,
    }).execute({ workspaceId, userId: user.id }, data);
  });
