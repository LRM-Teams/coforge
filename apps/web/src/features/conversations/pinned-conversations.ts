import type { DirectorySectionId } from "./directory-sections";

/** One row of the sidebar's Pinned section: a pinned channel or a pinned DM, keyed by the id the
 * row addresses it by (channel id, or the DM's Agent id). */
export type PinnedConversation<Channel, Direct> =
  | { kind: "channel"; id: string; channel: Channel }
  | { kind: "direct"; id: string; direct: Direct };

/**
 * Splits the sidebar's rows into the Pinned section and the rest. A member's pins share one order
 * across channels and DMs (the server appends each new pin after the others), so the Pinned
 * section merges both kinds by it; a pinned row appears there and nowhere else, even after the
 * member closes the chat (closing only takes a row out of its own section). Equal orders (pins
 * from before the order was shared) keep channels first, each kind in its own list's order.
 */
export function splitPinnedConversations<
  Channel extends { id: string; pinned: boolean; pinSortOrder: number | null },
  Direct extends {
    agent: { id: string };
    preference: { pinned: boolean; sortOrder: number | null; hidden: boolean };
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
    directs: directs.filter((direct) => !direct.preference.pinned && !direct.preference.hidden),
  };
}

/** Row keys per section, in display order: `channel:<channelId>` or `direct:<agentId>`. */
export type DirectoryLayout = Record<DirectorySectionId, string[]>;

export function channelRowKey(channelId: string) {
  return `channel:${channelId}`;
}
export function directRowKey(agentId: string) {
  return `direct:${agentId}`;
}

/** The section a row lives in when it is not pinned. */
function homeSection(key: string): "channels" | "agents" {
  return key.startsWith("channel:") ? "channels" : "agents";
}

/**
 * Moves one row to `to` while it is dragged. Pinned takes any row at `index`; a row's own section
 * takes it back at its natural place (each section keeps the order its own list gives, so it is
 * not reordered by hand); the other kind's section refuses it and the layout comes back unchanged.
 */
export function moveInDirectory(
  layout: DirectoryLayout,
  natural: Record<"channels" | "agents", readonly string[]>,
  key: string,
  to: DirectorySectionId,
  index: number,
): DirectoryLayout {
  const home = homeSection(key);
  if (to !== "pinned" && to !== home) return layout;
  const without: DirectoryLayout = {
    pinned: layout.pinned.filter((entry) => entry !== key),
    channels: layout.channels.filter((entry) => entry !== key),
    agents: layout.agents.filter((entry) => entry !== key),
  };
  if (to === "pinned") {
    const at = Math.max(0, Math.min(index, without.pinned.length));
    without.pinned.splice(at, 0, key);
    return without;
  }
  const present = new Set([...without[home], key]);
  without[home] = natural[home].filter((entry) => present.has(entry));
  return without;
}

/** The member's new pin list after a drag, or `null` when the drag left the pins as they were. */
export function pinsAfterDrag(before: DirectoryLayout, after: DirectoryLayout) {
  const same =
    before.pinned.length === after.pinned.length &&
    before.pinned.every((key, index) => after.pinned[index] === key);
  if (same) return null;
  return after.pinned.map((key) =>
    key.startsWith("channel:")
      ? { kind: "channel" as const, channelId: key.slice("channel:".length) }
      : { kind: "direct" as const, agentId: key.slice("direct:".length) },
  );
}
