/**
 * Conversation thread selection as URL search state.
 *
 * `threadRootId` on the conversation routes is the source of truth for whether
 * the thread pane is open (TanStack Router: search params are application
 * state). `#message-<uuid>` is only a scroll target; it must not keep the pane
 * open after the user closes it.
 */

export function messageIdFromHash(hash: string): string | undefined {
  if (!hash.startsWith("#message-")) return;
  const messageId = hash.slice("#message-".length);
  return messageId || undefined;
}

export function threadRootFromMessageAnchor(
  messages: ReadonlyArray<{ id: string; threadRootId?: string }>,
  hash: string,
): string | undefined {
  const messageId = messageIdFromHash(hash);
  if (!messageId) return;
  const message = messages.find((candidate) => candidate.id === messageId);
  return message?.threadRootId ?? message?.id;
}

/** Prefer the search param; if it names a reply, resolve to that reply's root. */
export function resolveConversationThreadRoot(input: {
  searchThreadRootId: string | undefined;
  messages: ReadonlyArray<{ id: string; threadRootId?: string }>;
}): string | undefined {
  if (!input.searchThreadRootId) return;
  const message = input.messages.find((candidate) => candidate.id === input.searchThreadRootId);
  return message?.threadRootId ?? message?.id ?? input.searchThreadRootId;
}

export function conversationSearchWithThread<T extends { threadRootId?: string }>(
  previous: T,
  threadRootId: string,
): T {
  return { ...previous, threadRootId };
}

export function conversationSearchWithoutThread<T extends { threadRootId?: string }>(
  previous: T,
): Omit<T, "threadRootId"> {
  const { threadRootId: _threadRootId, ...rest } = previous;
  return rest;
}
