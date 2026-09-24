import { CONVERSATION_TABS } from "#src/features/conversations/conversation-tabs";
import { AGENT_PROFILE_TABS } from "#src/features/agents/profile-panel/profile-panel-search";

/**
 * A member's saved tab order for a panel's tab strip. The saved order is a list of that panel's
 * tab ids; the first tab it arranges is the one the panel opens on when the URL names none.
 */

/** Every panel with a reorderable strip, and its tabs in default order. */
export const PANEL_TABS = {
  conversation: CONVERSATION_TABS,
  agentProfile: AGENT_PROFILE_TABS,
} as const;

export type TabOrderPanel = keyof typeof PANEL_TABS;
export type PanelTab<P extends TabOrderPanel> = (typeof PANEL_TABS)[P][number];
export type TabOrders = { [P in TabOrderPanel]: PanelTab<P>[] };

export const TAB_ORDER_PANELS = Object.keys(PANEL_TABS) as [TabOrderPanel, ...TabOrderPanel[]];
export const EMPTY_TAB_ORDERS: TabOrders = { conversation: [], agentProfile: [] };

/** Whether `order` lists only `panel`'s tabs, each at most once. */
export function isTabOrder<P extends TabOrderPanel>(
  panel: P,
  order: readonly string[],
): order is PanelTab<P>[] {
  const tabs: readonly string[] = PANEL_TABS[panel];
  return new Set(order).size === order.length && order.every((id) => tabs.includes(id));
}

/** The ids in `saved` that are still tabs of `panel`, in their saved order. */
export function knownTabs<P extends TabOrderPanel>(
  panel: P,
  saved: readonly string[],
): PanelTab<P>[] {
  const tabs: readonly string[] = PANEL_TABS[panel];
  return saved.filter((id): id is PanelTab<P> => tabs.includes(id));
}

/**
 * The visible tabs in the saved order, followed by any visible tab the order does not mention in
 * its default position. Saved tabs the viewer cannot see are skipped.
 */
export function arrangeTabs<T extends string>(visible: readonly T[], saved: readonly T[]): T[] {
  const remaining = new Set<T>(visible);
  return [...saved, ...visible].filter((id) => remaining.delete(id));
}

/**
 * The full order to save after the viewer drags `visibleOrder` into place. Tabs the viewer cannot
 * see keep their saved slots, so reordering as a manager does not move the owner-only Workspace
 * tab the same user placed while viewing an Agent they own.
 */
export function reorderTabs<T extends string>(
  all: readonly T[],
  saved: readonly T[],
  visibleOrder: readonly T[],
): T[] {
  const moved = new Set<T>(visibleOrder);
  let next = 0;
  return arrangeTabs(all, saved).map((id) => (moved.has(id) ? visibleOrder[next++] : id));
}
