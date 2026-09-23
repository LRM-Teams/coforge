/**
 * The jump-back a Saved card performs (#127): from the saved row's own conversation context to
 * the original message, through the `#message-<id>` hash anchor the notification deep links
 * already promote (both conversation panes resolve it to the loaded row — no second addressing
 * scheme for messages).
 *
 * Channels route by their conversation id; direct messages route by Agent id, which the
 * repository encodes structurally in `directKey` (`agent:<agentId>|user:<userId>`, `keyFor` in
 * the direct-conversation repository), so the parse never guesses from UUIDs or a viewer id. An
 * unparsable key (a legacy row) degrades to the conversation list instead of a broken route.
 */

/** Where a saved message's card navigates: its conversation at the message's hash anchor. */
export type SavedJumpTarget =
  | { to: "/messages/channels/$channelId"; params: { channelId: string }; hash: string }
  | { to: "/messages/$agentId"; params: { agentId: string }; hash: string }
  | { to: "/messages" };

/** The Agent id encoded in a direct conversation's `directKey`; null when absent or malformed. */
export function agentIdFromDirectKey(directKey: string | null): string | null {
  if (!directKey) return null;
  return /^agent:([^|]+)\|user:/.exec(directKey)?.[1] ?? null;
}

/** Where a saved message's card navigates: its own conversation at its hash anchor. */
export function savedJumpTarget(
  conversation: { id: string; channelName: string | null; directKey: string | null },
  messageId: string,
): SavedJumpTarget {
  if (conversation.channelName) {
    return {
      to: "/messages/channels/$channelId",
      params: { channelId: conversation.id },
      hash: `message-${messageId}`,
    };
  }
  const agentId = agentIdFromDirectKey(conversation.directKey);
  if (agentId) {
    return {
      to: "/messages/$agentId",
      params: { agentId },
      hash: `message-${messageId}`,
    };
  }
  return { to: "/messages" };
}
