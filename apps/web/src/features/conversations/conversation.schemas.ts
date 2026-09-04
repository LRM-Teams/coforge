import { z } from "zod";

const uuid = z.uuid();

export const agentConversationInputSchema = z.object({ agentId: uuid });
export const sendConversationMessageInputSchema = agentConversationInputSchema.extend({
  requestId: uuid,
  body: z.string().trim().min(1).max(8_000),
  attachmentId: uuid.optional(),
});
