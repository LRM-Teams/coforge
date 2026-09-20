import { z } from "zod";

const uuid = z.uuid();

/** Attachments already uploaded to this conversation, unlinked to any message, in send order.
 * Bounded and unique, mirroring `isValidMentionSelectorArray`'s shape (array, max length,
 * per-item validity) in `@lrm/coforge-sdk/internal/mentions.ts`. This composer migrates fully
 * to the array field rather than keeping the old singular `attachmentId` for compatibility:
 * browser and server deploy together in this monorepo, so there is no external client to break. */
export const attachmentIdsSchema = z
  .array(uuid)
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "attachmentIds must not contain duplicates",
  })
  .optional();

/**
 * A page of a conversation's message stream. `beforeSequence` pages up into history;
 * `afterSequence` pages down towards the live end once the retained newest page is no longer the
 * tail (the bounded window evicts it). At most one is set, and neither is the initial load.
 * `limit` is the window's own page size (see `lib/conversation-window.ts`).
 */
export const conversationPageInputSchema = {
  beforeSequence: z.number().int().positive().optional(),
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
export const agentConversationInputSchema = z.object({ agentId: uuid });
export const agentConversationPageInputSchema = agentConversationInputSchema.extend(
  conversationPageInputSchema,
);
const conversationHistoryInputSchema = z.object({ conversationId: uuid });
export const ownMessageIndexInputSchema = conversationHistoryInputSchema.extend({
  beforeSequence: z.number().int().positive().optional(),
});
export const conversationAroundInputSchema = conversationHistoryInputSchema.extend({
  messageId: uuid,
});
export const agentConversationUpdatesInputSchema = agentConversationInputSchema.extend({
  afterSequence: z.number().int().nonnegative(),
});
export const sendConversationMessageInputSchema = agentConversationInputSchema.extend({
  requestId: uuid,
  body: z.string().trim().min(1).max(8_000),
  attachmentIds: attachmentIdsSchema,
  threadRootId: uuid.optional(),
});

export const readConversationThreadInputSchema = agentConversationInputSchema.extend({
  threadRootId: uuid,
  throughSequence: z.number().int().positive(),
});
