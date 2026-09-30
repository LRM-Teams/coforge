import type { loadDirectConversationPreferences } from "./conversations.functions";

/** What the server says about the viewer's DMs, by conversation id; the stream positions it was
 * read at (`streamPositions`) belong to the list, not to a row. */
type DirectPreferences = Omit<
  Awaited<ReturnType<typeof loadDirectConversationPreferences>>,
  "streamPositions"
>;

/** Who a DM is with: the viewer's Agent, or a member (the viewer themself in their own DM). */
export type DirectPeer = DirectPreferences["conversations"][number]["peer"];

/**
 * One DM's row in the Chat sidebar's Direct messages (see `sidebar-lists.ts`), with an Agent or a
 * member alike: who it is with, its pin, whether it is closed, and its unread count. The fields a
 * sidebar change touches are named as on a channel row, so one change reads the same for both.
 */
export type DirectRow = {
  conversationId: string;
  /** Where the server lists it (the order the DMs started): the synced collection hands rows back
   * in its own key order, so the list sorts by this. */
  position: number;
  peer: DirectPeer;
  pinned: boolean;
  pinSortOrder: number | null;
  hidden: boolean;
  unreadCount: number;
};

/** One row per DM the preferences list, in their order, with its unread count. */
export function directRowsOf(
  preferences: DirectPreferences,
  unread: Readonly<Record<string, number>>,
): DirectRow[] {
  const pins = new Map(preferences.pinned.map((pin) => [pin.conversationId, pin.sortOrder]));
  const hidden = new Set(preferences.hidden);
  return preferences.conversations.map(({ conversationId, peer }, position) => ({
    conversationId,
    position,
    peer,
    pinned: pins.has(conversationId),
    pinSortOrder: pins.get(conversationId) ?? null,
    hidden: hidden.has(conversationId),
    unreadCount: unread[conversationId] ?? 0,
  }));
}

/** The rows as the sidebar reads them: all of them in the server's order, each Agent's own DM
 * (for what opens it from outside the list), the closed ones (a closed DM that is pinned stays
 * listed, in Pinned), and the unread counts, all by conversation id. */
export function directListsOf(unordered: readonly DirectRow[]) {
  const rows = [...unordered].sort((left, right) => left.position - right.position);
  return {
    rows,
    agentDms: new Map(
      rows.flatMap((row) =>
        row.peer.kind === "agent" ? [[row.peer.agentId, row.conversationId] as const] : [],
      ),
    ),
    closedIds: rows.filter((row) => row.hidden && !row.pinned).map((row) => row.conversationId),
    unread: Object.fromEntries(
      rows.filter((row) => row.unreadCount > 0).map((row) => [row.conversationId, row.unreadCount]),
    ),
  };
}

/** The direct messages the sidebar lists, by conversation id: each open one with a member, or with
 * an Agent that is still in the Workspace. */
export function listedDirectIds(
  lists: ReturnType<typeof directListsOf>,
  agents: readonly { id: string }[],
): string[] {
  const closed = new Set(lists.closedIds);
  const live = new Set(agents.map((agent) => agent.id));
  return lists.rows.flatMap((row) =>
    !closed.has(row.conversationId) && (row.peer.kind === "people" || live.has(row.peer.agentId))
      ? [row.conversationId]
      : [],
  );
}
