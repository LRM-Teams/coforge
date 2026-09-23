export type ConversationRowMenuItemId = "mark-unread" | "pin" | "close-chat";

export type ConversationRowMenuItem = {
  id: ConversationRowMenuItemId;
  /** The row's current pin state, so the pin item can read "Pin" or "Unpin". */
  pinned: boolean;
};

/**
 * Whether a directory row offers the right-click menu (#126). Only an active member's row: the
 * P2b mutations guard membership server-side, so an unjoined row offering them could only ever
 * fail with ACCESS_DENIED.
 */
export function conversationRowMenuEnabled(channel: { joined: boolean }): boolean {
  return channel.joined;
}

/**
 * The menu's items in the mockup's order (#122): Mark as Unread and Pin as the everyday actions,
 * Close Chat last behind a separator (the separator is presentation, drawn before the last item).
 * "Move to section" left the plan with its schema field.
 */
export function conversationRowMenuItems(channel: {
  pinned: boolean;
}): readonly ConversationRowMenuItem[] {
  return [
    { id: "mark-unread", pinned: false },
    { id: "pin", pinned: channel.pinned },
    { id: "close-chat", pinned: false },
  ];
}

/** How long a touch must stay put before it opens the menu instead of tapping or scrolling. */
export const LONG_PRESS_MS = 500;

/** Pixels of drift (beyond this on the combined move) that turn a hold into a scroll/drag. */
export const LONG_PRESS_SLOP_PX = 10;

/** The touch point expressed in the row's coordinate space — the same space the pointer path
 * (right-click, keyboard fallback) anchors the popover in. */
export function longPressAnchorPoint(
  clientX: number,
  clientY: number,
  row: { left: number; top: number },
): { left: number; top: number } {
  return { left: clientX - row.left, top: clientY - row.top };
}

/** Whether the touch drifted past the slop since the hold started: then it is a scroll/drag,
 * not a long-press, and the menu must not open. */
export function movedBeyondSlop(
  start: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > LONG_PRESS_SLOP_PX;
}

/** A click that arrives while the menu is open is the long-press's own release (or a tap on the
 * row under an open menu): swallow it, so the row neither navigates underneath the popover nor
 * re-opens. A click with the menu closed is an ordinary navigation and passes through. */
export function rowClickSuppressed(menuOpen: boolean): boolean {
  return menuOpen;
}

/** What one DM row needs, resolved from the sidebar's preferences (P2b, #708): whether the Agent
 * row is a conversation at all (`enabled`), whether it is pinned, and whether it is closed. An
 * Agent the viewer has never written to has no conversation: the menu is not offered, because a
 * preference would only answer NOT_FOUND. */
export function directRowPreference(
  preferences: {
    conversations: readonly string[];
    pinned: readonly { agentId: string; sortOrder: number }[];
    hidden: readonly string[];
  },
  agentId: string,
): { enabled: boolean; pinned: boolean; hidden: boolean; sortOrder: number | null } {
  const pin = preferences.pinned.find((entry) => entry.agentId === agentId);
  return {
    enabled: preferences.conversations.includes(agentId),
    pinned: pin !== undefined,
    // Only a conversation can be closed: an Agent row with no DM has nothing to hide and stays
    // in the list as a way to start one.
    hidden: preferences.hidden.includes(agentId),
    sortOrder: pin?.sortOrder ?? null,
  };
}
