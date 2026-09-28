import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import {
  activityInboxPageSchema,
  activityInboxReadAllSchema,
  activityItemDoneSchema,
  activityMentionReadSchema,
} from "./activity-inbox.schemas";

/** One page of the viewer's Activity inbox, newest activity first, with the view's totals. */
export const loadActivityInbox = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(activityInboxPageSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    return new ActivityInbox(db).list(workspaceId, user.id, data);
  });

/** Marks one item Done (and read) through the newest message the viewer saw in it. */
export const markActivityItemDone = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityItemDoneSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await new ActivityInbox(db).markDone(workspaceId, user.id, data);
  });

/** Reads every joined conversation and listed thread up to when the viewer's list was loaded;
 * items stay listed. */
export const markActivityInboxRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityInboxReadAllSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await new ActivityInbox(db).markAllRead(workspaceId, user.id, {
      before: new Date(data.before),
    });
  });

/** The viewer's unread-activity count for the nav rail's Activity dot. */
export const loadActivityNavAttention = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { db, workspaceId, user } = context;
    return new ActivityInbox(db).navAttention(workspaceId, user.id);
  });

/** Reads or unreads a mention the viewer was notified of; it stays listed until Done. */
export const setActivityMentionRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(activityMentionReadSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    await new ActivityInbox(db).setMentionRead(workspaceId, user.id, data.resolutionId, data.read);
  });
