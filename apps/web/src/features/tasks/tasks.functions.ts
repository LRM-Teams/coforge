import { TASK_STATUSES, type TaskCommand } from "@lrm/coforge-sdk/internal";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { bestEffortMessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const taskCommand = z
  .object({
    operation: z.enum([
      "list",
      "create",
      "convert",
      "claim",
      "unclaim",
      "update",
      "assign",
      "unassign",
      "amend",
      "history",
      "delete",
      "receipt",
    ]),
    idempotencyKey: z.uuid(),
    conversationId: z.uuid(),
    target: z.never().optional(),
    number: z.number().int().positive().optional(),
    messageId: z.string().min(8).max(36).optional(),
    title: z.string().trim().min(1).max(8_000).optional(),
    titles: z.array(z.string().trim().min(1).max(8_000)).min(1).optional(),
    numbers: z.array(z.number().int().positive()).min(1).optional(),
    messageIds: z.array(z.string().min(8).max(36)).min(1).optional(),
    mine: z.boolean().optional(),
    assignee: z.string().nullable().optional(),
    description: z.string().max(50_000).nullable().optional(),
    createsResource: z.boolean().optional(),
    freshnessContextMode: z.enum(["inline", "withheld"]).optional(),
    receipt: z
      .object({
        object: z.string().min(1),
        purpose: z.string().min(1),
        teardownOwner: z.string().min(1),
        securityPrivacy: z.string().min(1),
        expiry: z.iso.datetime(),
        runbook: z.string().min(1),
        tracking: z.string().min(1),
      })
      .optional(),
    attachmentId: z.uuid().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const loadTaskOverview = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).overview(workspaceId, user.id);
  });

/** One Task as the Tasks page shows it, in any status; null when the viewer cannot see it. */
export const loadOverviewTask = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.uuid(), number: z.number().int().positive() }).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).overviewTask({ workspaceId, userId: user.id }, data);
  });

/** Where a finished-work read looks: the Workspace Tasks page, or one conversation's Tasks tab. */
const finishedScope = {
  conversationId: z.uuid().optional(),
  window: z.enum(["week", "month", "all"]),
};

/** Finished Tasks counted by status, owner and Project for the chosen window. */
export const loadFinishedTaskSummary = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object(finishedScope).strict())
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new TaskBoard(db).finishedSummary(
      { workspaceId, userId: user.id, conversationId: data.conversationId },
      { window: data.window },
    );
  });

/** One page of finished Tasks in one status; `cursor` is the previous page's `nextCursor`. */
export const loadFinishedTasks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        ...finishedScope,
        status: z.enum(["done", "closed"]),
        cursor: z.string().max(100).nullable().optional(),
        owners: z.array(z.string().min(1).max(64)).max(100).optional(),
        projects: z.array(z.string().min(1).max(64)).max(100).optional(),
      })
      .strict(),
  )
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const { conversationId, ...query } = data;
    return new TaskBoard(db).finishedPage({ workspaceId, userId: user.id, conversationId }, query);
  });

export const executeTask = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((data: TaskCommand): TaskCommand => taskCommand.parse(data))
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const centrifugo = createCentrifugoServerApi();
    return new TaskBoard(db, {
      notifications: bestEffortMessageNotifier(db),
      realtime: new CentrifugoConversationRealtime(centrifugo),
      publisher: centrifugo,
    }).execute({ workspaceId, userId: user.id }, data);
  });
