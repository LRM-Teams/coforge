import { z } from "zod";

import {
  agentProfileParamSchema,
  agentProfileTabParamSchema,
} from "#src/features/agents/profile-panel/profile-panel-search";
import { conversationTaskBoardSearchShape } from "#src/features/tasks/task-board-search";
import { CONVERSATION_TABS } from "./conversation-tabs";
import { openTaskParamSchema } from "./conversation-thread-search";

/**
 * A conversation page's address state wherever the page is shown (Chat, the search preview): the
 * tab, the Task board's view, and what it has open (a thread, a Task popup, an Agent profile).
 * Every host's `validateSearch` spreads it; Chat's routes add `message`, the one-shot jump.
 */
export const conversationPageSearchShape = {
  view: z.enum(CONVERSATION_TABS).optional().catch(undefined),
  ...conversationTaskBoardSearchShape,
  threadRootId: z.uuid().optional().catch(undefined),
  task: openTaskParamSchema,
  profile: agentProfileParamSchema,
  agentTab: agentProfileTabParamSchema,
};

export type ConversationPageSearch = z.output<z.ZodObject<typeof conversationPageSearchShape>>;

const PAGE_SEARCH_KEYS = Object.keys(
  conversationPageSearchShape,
) as (keyof ConversationPageSearch)[];

/** Only a conversation page's own fields out of a host's address. */
export function pickConversationPageSearch(
  search: Partial<Record<keyof ConversationPageSearch, unknown>>,
): ConversationPageSearch {
  return Object.fromEntries(
    PAGE_SEARCH_KEYS.map((key) => [key, search[key]]),
  ) as ConversationPageSearch;
}
