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

/**
 * `T extends object`, not `T extends { threadRootId?: string }`: that constraint is a weak type
 * (every property optional), so search that does not already carry `threadRootId` has no property
 * in common with it and is rejected — while this function's whole job is adding the property to
 * search that lacks it. The return type says what it did, instead of claiming the input type back.
 */
export function conversationSearchWithThread<T extends object>(
  previous: T,
  threadRootId: string,
): T & { threadRootId: string } {
  return { ...previous, threadRootId };
}

export function conversationSearchWithoutThread<T extends { threadRootId?: string }>(
  previous: T,
): Omit<T, "threadRootId"> {
  const { threadRootId: _threadRootId, ...rest } = previous;
  return rest;
}

export function conversationSearchWithoutAgentProfile<
  T extends { profile?: string; agentTab?: unknown },
>(previous: T): Omit<T, "profile" | "agentTab"> {
  const { profile: _profile, agentTab: _agentTab, ...rest } = previous;
  return rest;
}
