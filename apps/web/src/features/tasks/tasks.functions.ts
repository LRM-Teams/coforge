import { TASK_STATUSES, type TaskCommand } from "@lrm/coforge-sdk/internal";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { bestEffortMessageNotifier } from "../../server/notifications/web-push-composition.server";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import { TaskBoard } from "../../server/tasks/task-board.server";

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
    requestId: z.uuid(),
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

export const executeTask = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((data: unknown): TaskCommand => taskCommand.parse(data))
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const centrifugo = createCentrifugoServerApi();
    return new TaskBoard(db, {
      notifications: bestEffortMessageNotifier(db),
      realtime: new CentrifugoConversationRealtime(centrifugo),
      publisher: centrifugo,
    }).execute({ workspaceId, userId: user.id }, data);
  });
