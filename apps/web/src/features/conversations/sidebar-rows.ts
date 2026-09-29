import type { loadDirectConversationPreferences } from "./conversations.functions";

/** What the server says about the viewer's DMs, keyed by Agent id. */
type DirectPreferences = Awaited<ReturnType<typeof loadDirectConversationPreferences>>;

/**
 * One Agent's row in the Chat sidebar's DM list (see `sidebar-lists.ts`): its DM's id, its pin,
 * whether it is closed, and its unread count. The fields a sidebar change touches are named as
 * on a channel row, so one change reads the same for both.
 */
export type DirectRow = {
  agentId: string;
  /** The DM's own id, when the viewer has one with this Agent. */
  conversationId: string | null;
  pinned: boolean;
  pinSortOrder: number | null;
  hidden: boolean;
  unreadCount: number;
};

/** Every Agent the preferences or the unread counts name, one row each, in the order first named. */
export function directRowsOf(
  preferences: DirectPreferences,
  unread: Readonly<Record<string, number>>,
): DirectRow[] {
  const pins = new Map(preferences.pinned.map((pin) => [pin.agentId, pin.sortOrder]));
  const conversations = new Map(
    preferences.conversations.map((row) => [row.agentId, row.conversationId]),
  );
  const hidden = new Set(preferences.hidden);
  const agentIds = new Set([
    ...conversations.keys(),
    ...pins.keys(),
    ...preferences.hidden,
    ...Object.keys(unread),
  ]);
  return [...agentIds].map((agentId) => ({
    agentId,
    conversationId: conversations.get(agentId) ?? null,
    pinned: pins.has(agentId),
    pinSortOrder: pins.get(agentId) ?? null,
    hidden: hidden.has(agentId),
    unreadCount: unread[agentId] ?? 0,
  }));
}

/** The rows as the sidebar reads them: by Agent, the closed ones (a closed DM that is pinned stays
 * listed, in Pinned), and the unread counts. */
export function directListsOf(rows: readonly DirectRow[]) {
  return {
    byAgent: new Map(rows.map((row) => [row.agentId, row])),
    hiddenAgentIds: rows.filter((row) => row.hidden && !row.pinned).map((row) => row.agentId),
    unread: Object.fromEntries(
      rows.filter((row) => row.unreadCount > 0).map((row) => [row.agentId, row.unreadCount]),
    ),
  };
}

/** The direct messages the sidebar lists, by conversation id: one per existing conversation with a
 * live Agent, leaving out the closed ones `directListsOf` names. */
export function listedDirectIds(
  lists: ReturnType<typeof directListsOf>,
  agents: readonly { id: string }[],
): string[] {
  const closed = new Set(lists.hiddenAgentIds);
  return agents.flatMap((agent) => {
    const conversationId = lists.byAgent.get(agent.id)?.conversationId;
    return conversationId && !closed.has(agent.id) ? [conversationId] : [];
  });
}
