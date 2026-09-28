import { z } from "zod";

import { conversationTaskBoardSearchShape } from "#src/features/tasks/task-board-search";
import { CONVERSATION_TABS } from "./conversation-tabs";
import { conversationOpenSearchShape } from "./conversation-thread-search";

/**
 * A conversation page's address state wherever the page is shown (Chat, the search preview): the
 * tab, the Task board's view and what the conversation has open. Chat's routes add `message`, the
 * one-shot jump; the search preview keeps its jump target itself.
 */
export const conversationPageSearchShape = {
  view: z.enum(CONVERSATION_TABS).optional().catch(undefined),
  ...conversationTaskBoardSearchShape,
  ...conversationOpenSearchShape,
};

export type ConversationPageSearch = z.output<z.ZodObject<typeof conversationPageSearchShape>> & {
  message?: string;
};
