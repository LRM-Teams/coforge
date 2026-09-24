/** One row of the sidebar's Pinned section: a pinned channel or a pinned DM, keyed by the id the
 * row addresses it by (channel id, or the DM's Agent id). */
export type PinnedConversation<Channel, Direct> =
  | { kind: "channel"; id: string; channel: Channel }
  | { kind: "direct"; id: string; direct: Direct };

/**
 * Splits the sidebar's rows into the Pinned section and the rest. A member's pins share one order
 * across channels and DMs (the server appends each new pin after the others), so the Pinned
 * section merges both kinds by it; a pinned row appears there and nowhere else. Equal orders
 * (pins from before the order was shared) keep channels first, each kind in its own list's order.
 */
export function splitPinnedConversations<
  Channel extends { id: string; pinned: boolean; pinSortOrder: number | null },
  Direct extends {
    agent: { id: string };
    preference: { pinned: boolean; sortOrder: number | null };
  },
>(channels: readonly Channel[], directs: readonly Direct[]) {
  const pinned = [
    ...channels
      .filter((channel) => channel.pinned)
      .map((channel) => ({
        order: channel.pinSortOrder ?? 0,
        entry: { kind: "channel", id: channel.id, channel } as const,
      })),
    ...directs
      .filter((direct) => direct.preference.pinned)
      .map((direct) => ({
        order: direct.preference.sortOrder ?? 0,
        entry: { kind: "direct", id: direct.agent.id, direct } as const,
      })),
  ]
    .sort((left, right) => left.order - right.order)
    .map(({ entry }): PinnedConversation<Channel, Direct> => entry);
  return {
    pinned,
    channels: channels.filter((channel) => !channel.pinned),
    directs: directs.filter((direct) => !direct.preference.pinned),
  };
}
