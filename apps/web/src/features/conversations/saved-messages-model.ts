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
 * Channels and direct messages both route by their conversation id.
 */

/** Where a saved message's card navigates: its conversation, anchored at the stream position. */
export type SavedJumpTarget =
  | {
      to: "/w/$workspaceSlug/channel/$channelId";
      params: { workspaceSlug: string; channelId: string };
      search: { message: string };
    }
  | {
      to: "/w/$workspaceSlug/dm/$dmId";
      params: { workspaceSlug: string; dmId: string };
      search: { message: string };
    };

/**
 * Where a saved message's card navigates: its own conversation in the Workspace `workspaceSlug`
 * names, anchored at the row that shows it in the stream — the root for a thread reply, the
 * message itself otherwise, as a position-only `?message=` search param (never a hash; see the
 * module note).
 */
export function savedJumpTarget(
  workspaceSlug: string,
  conversation: { id: string; channelName: string | null },
  message: { id: string; threadRootId?: string | null },
): SavedJumpTarget {
  const anchorId = message.threadRootId ?? message.id;
  if (conversation.channelName) {
    return {
      to: "/w/$workspaceSlug/channel/$channelId",
      params: { workspaceSlug, channelId: conversation.id },
      search: { message: anchorId },
    };
  }
  return {
    to: "/w/$workspaceSlug/dm/$dmId",
    params: { workspaceSlug, dmId: conversation.id },
    search: { message: anchorId },
  };
}
