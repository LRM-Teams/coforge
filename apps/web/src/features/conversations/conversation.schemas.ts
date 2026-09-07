import { z } from "zod";

const uuid = z.uuid();

export const agentConversationInputSchema = z.object({ agentId: uuid });
export const agentConversationPageInputSchema = agentConversationInputSchema.extend({
  beforeSequence: z.number().int().positive().optional(),
});
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
  attachmentId: uuid.optional(),
  threadRootId: uuid.optional(),
});

export const readConversationThreadInputSchema = agentConversationInputSchema.extend({
  threadRootId: uuid,
  throughSequence: z.number().int().positive(),
});
