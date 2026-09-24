/**
 * The Chat sidebar's lists as keyed rows: one per channel (the channel list's own rows) and one
 * per Agent for direct messages. Rows are what a pin, a mark-unread, a close or a drag changes on
 * screen before the server answers (see `sidebar-lists.ts`); these are the pure conversions
 * between the rows and what the sidebar and the server exchange.
 */

/** What the server says about the viewer's DMs, keyed by Agent id. */
export type DirectPreferences = {
  conversations: readonly string[];
  pinned: readonly { agentId: string; sortOrder: number }[];
  hidden: readonly string[];
};

/** One Agent's row in the DM list: whether a DM exists, its pin, whether it is closed, and its
 * unread count. */
export type DirectRow = {
  agentId: string;
  conversation: boolean;
  pinned: boolean;
  sortOrder: number | null;
  hidden: boolean;
  unread: number;
};

/** Every Agent the preferences or the unread counts name, one row each, in the order first named. */
export function directRowsOf(
  preferences: DirectPreferences,
  unread: Readonly<Record<string, number>>,
): DirectRow[] {
  const pins = new Map(preferences.pinned.map((pin) => [pin.agentId, pin.sortOrder]));
  const conversations = new Set(preferences.conversations);
  const hidden = new Set(preferences.hidden);
  const agentIds = new Set([
    ...preferences.conversations,
    ...pins.keys(),
    ...preferences.hidden,
    ...Object.keys(unread),
  ]);
  return [...agentIds].map((agentId) => ({
    agentId,
    conversation: conversations.has(agentId),
    pinned: pins.has(agentId),
    sortOrder: pins.get(agentId) ?? null,
    hidden: hidden.has(agentId),
    unread: unread[agentId] ?? 0,
  }));
}

/** The rows as the sidebar reads them. A closed DM that is pinned stays listed (in Pinned), so it
 * is not reported closed. */
export function directViewOf(rows: readonly DirectRow[]): {
  preferences: DirectPreferences;
  unread: Record<string, number>;
} {
  return {
    preferences: {
      conversations: rows.filter((row) => row.conversation).map((row) => row.agentId),
      pinned: rows
        .filter((row) => row.pinned)
        .map((row) => ({ agentId: row.agentId, sortOrder: row.sortOrder ?? 0 }))
        .sort((left, right) => left.sortOrder - right.sortOrder),
      hidden: rows.filter((row) => row.hidden && !row.pinned).map((row) => row.agentId),
    },
    unread: Object.fromEntries(
      rows.filter((row) => row.unread > 0).map((row) => [row.agentId, row.unread]),
    ),
  };
}

/** The order a new pin takes: after every pin the member has, channels and DMs alike. */
export function nextPinOrder(pins: readonly { pinned: boolean; order: number | null }[]) {
  return pins.reduce((next, pin) => (pin.pinned ? Math.max(next, (pin.order ?? 0) + 1) : next), 0);
}

/**
 * Every pin's order after a drag, keyed like the sidebar's rows (`channel:<id>`, `direct:<id>`):
 * the arranged pins take the first places, the rows dragged out are unpinned (`null`), and the
 * member's other pins follow in their old order. The server applies the same rule
 * (`arrangeConversationPins`), so the screen shows what it will store.
 */
export function pinOrdersAfterArrange(
  current: readonly { key: string; order: number }[],
  arrangement: { pins: readonly string[]; unpinned: readonly string[] },
) {
  const arranged = new Set(arrangement.pins);
  const unpinned = new Set(arrangement.unpinned);
  const others = [...current]
    .sort((left, right) => left.order - right.order)
    .filter((pin) => !arranged.has(pin.key) && !unpinned.has(pin.key));
  return new Map<string, number | null>([
    ...arrangement.pins.map((key, index) => [key, index] as const),
    ...others.map((pin, rank) => [pin.key, arrangement.pins.length + rank] as const),
    ...[...unpinned].filter((key) => !arranged.has(key)).map((key) => [key, null] as const),
  ]);
}
