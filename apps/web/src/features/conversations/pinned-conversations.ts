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

/** The section a row lives in when it is not pinned. */
export type HomeSection = Exclude<DirectorySectionId, "pinned">;

export function channelRowKey(channelId: string) {
  return `channel:${channelId}`;
}
export function directRowKey(agentId: string) {
  return `direct:${agentId}`;
}

/** The pin a row key stands for, the shape the server's pin list takes. */
function pinOfRowKey(key: string) {
  return key.startsWith("channel:")
    ? { kind: "channel" as const, channelId: key.slice("channel:".length) }
    : { kind: "direct" as const, agentId: key.slice("direct:".length) };
}

function homeSection(key: string): HomeSection {
  return pinOfRowKey(key).kind === "channel" ? "channels" : "agents";
}

/** Pinned takes any row; Channels and Direct messages take back only their own kind. */
export function canDropInto(key: string, section: DirectorySectionId) {
  return section === "pinned" || section === homeSection(key);
}

/**
 * Moves one row to `to` while it is dragged. Pinned takes any row at `index`; a row's own section
 * takes it back at its natural place (each section keeps the order its own list gives, so it is
 * not reordered by hand); the other kind's section refuses it and the layout comes back unchanged.
 */
export function moveInDirectory(
  layout: DirectoryLayout,
  natural: Record<HomeSection, readonly string[]>,
  key: string,
  to: DirectorySectionId,
  index: number,
): DirectoryLayout {
  if (!canDropInto(key, to)) return layout;
  const home = homeSection(key);
  const without: DirectoryLayout = {
    pinned: layout.pinned.filter((entry) => entry !== key),
    channels: layout.channels.filter((entry) => entry !== key),
    agents: layout.agents.filter((entry) => entry !== key),
  };
  if (to === "pinned") {
    const at = Math.max(0, Math.min(index, without.pinned.length));
    without.pinned.splice(at, 0, key);
  } else {
    const present = new Set([...without[home], key]);
    without[home] = natural[home].filter((entry) => present.has(entry));
  }
  // Called on every pointer move of a drag: a move that changes nothing keeps the same object, so
  // the sidebar does not re-render for it.
  return sameLayout(layout, without) ? layout : without;
}

function sameLayout(left: DirectoryLayout, right: DirectoryLayout) {
  return (Object.keys(left) as DirectorySectionId[]).every(
    (section) =>
      left[section].length === right[section].length &&
      left[section].every((key, index) => right[section][index] === key),
  );
}

/** What a drag changed about the member's pins: the Pinned rows in their new order and the rows
 * dragged out of Pinned. `null` when the drag left the pins as they were. */
export function pinsAfterDrag(before: DirectoryLayout, after: DirectoryLayout) {
  if (sameLayout({ ...before, channels: [], agents: [] }, { ...after, channels: [], agents: [] }))
    return null;
  return {
    pins: after.pinned.map(pinOfRowKey),
    unpinned: before.pinned.filter((key) => !after.pinned.includes(key)).map(pinOfRowKey),
  };
}

/** What a dragged row is over: a row (by key) or a list's own space, and in which section. */
export type DropOver = { key: string; section: DirectorySectionId; type: "row" | "section" };

/**
 * Where the dragged row `active` goes for what it is over, or `null` to leave the layout as it is.
 * Over a row, it goes above or below that row by which half of it the dragged row's centre is in
 * (`centres` are vertical positions); over a list's own space (between rows, an empty list) it
 * joins at the end, unless it is already in that list.
 */
export function dropTarget(
  layout: DirectoryLayout,
  active: string,
  over: DropOver,
  centres: { dragged: number; over: number } | null,
) {
  if (over.key === active) return null;
  const list = layout[over.section];
  if (over.type === "section")
    return list.includes(active) ? null : { section: over.section, index: list.length };
  const siblings = list.filter((key) => key !== active);
  const below = centres !== null && centres.dragged > centres.over;
  return { section: over.section, index: siblings.indexOf(over.key) + (below ? 1 : 0) };
}
