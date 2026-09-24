/** The conversation header's tabs, in their default order; the `view` search param names one. */
export const CONVERSATION_TABS = ["chat", "tasks", "files"] as const;
export type ConversationTab = (typeof CONVERSATION_TABS)[number];
