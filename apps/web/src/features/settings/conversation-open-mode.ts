/**
 * Slack's "When I view a conversation" behaviors (ADR 0046), shared by the Settings control,
 * the server preference validation, and the chat pane's open positioning. Framework-free so
 * both the browser bundle and server-only modules can import the same definition.
 */
export const CONVERSATION_OPEN_MODES = ["newest-read", "first-unread", "newest-unread"] as const;

export type ConversationOpenMode = (typeof CONVERSATION_OPEN_MODES)[number];

/**
 * Start where the viewer left off. Slack ships the same three choices under
 * "When I view a channel", and both Slack and Discord open a conversation at the unread
 * boundary rather than at the newest message, which is what makes the unread divider
 * something you land on instead of something scrolled past.
 */
export const DEFAULT_CONVERSATION_OPEN_MODE: ConversationOpenMode = "first-unread";

export function isConversationOpenMode(value: string): value is ConversationOpenMode {
  return (CONVERSATION_OPEN_MODES as readonly string[]).includes(value);
}

/**
 * Narrows a persisted preference (a plain string column) to the union, falling back to the
 * default for an unknown value rather than trusting the column's contents.
 */
export function conversationOpenMode(value: string | null | undefined): ConversationOpenMode {
  return value && isConversationOpenMode(value) ? value : DEFAULT_CONVERSATION_OPEN_MODE;
}
