/**
 * The jump-back a Saved card performs (#127, amended after the boss's ruling: clicking a
 * saved card lands at the message's POSITION in the conversation, never opens the thread
 * pane). Two consequences shape this module:
 *
 * - **No hash.** `#message-<id>` is the notification deep-link path —
 *   `threadRootFromMessageAnchor` resolves the anchor and `openThreadFromHash` unconditionally
 *   promotes it into `threadRootId` search, i.e. auto-opens the thread pane — which is exactly
 *   the behavior saved jumps must not inherit. Saved jumps carry the conversation routes'
 *   existing `?message=<uuid>` search param instead (already declared in both routes'
 *   `validateSearch`); the pane consumes it position-only: load the window around the anchor
 *   and scroll, thread untouched.
 * - **A thread reply renders only through its root's row**, so its anchor is the root id —
 *   "land on the row in the stream, open the thread yourself" (the agreed ①: muse + deepseek).
 *
 * Channels route by their conversation id; direct messages route by Agent id, which the
 * repository encodes structurally in `directKey` (`agent:<agentId>|user:<userId>`, `keyFor` in
 * the direct-conversation repository), so the parse never guesses from UUIDs or a viewer id. An
 * unparsable key (a legacy row) degrades to the conversation list instead of a broken route.
 */

/** Where a saved message's card navigates: its conversation, anchored at the stream position. */
export type SavedJumpTarget =
  | {
      to: "/messages/channels/$channelId";
      params: { channelId: string };
      search: { message: string };
    }
  | { to: "/messages/$agentId"; params: { agentId: string }; search: { message: string } }
  | { to: "/messages" };

/** The Agent id encoded in a direct conversation's `directKey`; null when absent or malformed. */
export function agentIdFromDirectKey(directKey: string | null): string | null {
  if (!directKey) return null;
  return /^agent:([^|]+)\|user:/.exec(directKey)?.[1] ?? null;
}

/**
 * Where a saved message's card navigates: its own conversation, anchored at the row that
 * shows it in the stream — the root for a thread reply, the message itself otherwise, as a
 * position-only `?message=` search param (never a hash; see the module note).
 */
export function savedJumpTarget(
  conversation: { id: string; channelName: string | null; directKey: string | null },
  message: { id: string; threadRootId?: string | null },
): SavedJumpTarget {
  const anchorId = message.threadRootId ?? message.id;
  if (conversation.channelName) {
    return {
      to: "/messages/channels/$channelId",
      params: { channelId: conversation.id },
      search: { message: anchorId },
    };
  }
  const agentId = agentIdFromDirectKey(conversation.directKey);
  if (agentId) {
    return {
      to: "/messages/$agentId",
      params: { agentId },
      search: { message: anchorId },
    };
  }
  return { to: "/messages" };
}
