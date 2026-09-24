import { z } from "zod";

/** The Activity page's three views: every listed item, only unread ones, only ones that
 * mention the viewer. */
export const ACTIVITY_INBOX_FILTERS = ["all", "unread", "mentions"] as const;
export type ActivityInboxFilter = (typeof ACTIVITY_INBOX_FILTERS)[number];

export const activityInboxPageSchema = z.object({
  filter: z.enum(ACTIVITY_INBOX_FILTERS),
  offset: z.number().int().min(0).optional(),
});

/** Marks one item Done through the newest message the viewer saw in it. */
export const activityItemDoneSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.uuid(),
    throughSequence: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal("thread"),
    conversationId: z.uuid(),
    rootMessageId: z.uuid(),
    throughSequence: z.number().int().min(1),
  }),
]);
export type ActivityItemDone = z.infer<typeof activityItemDoneSchema>;
