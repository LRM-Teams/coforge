import {
  Activity as ActivityIcon,
  Bell01 as Bell,
  Folder,
  UserCircle as UserRound,
} from "@untitledui/icons";

import { ReorderableTabStrip } from "@/components/ui/reorderable-tab-strip";
import { usePanelTabOrder } from "@/features/panel-tabs/panel-tab-order-context";
import { m } from "@/paraglide/messages";
import { visibleAgentProfileTabs, type AgentProfileTab } from "./profile-panel-search";

const TABS = {
  profile: { label: m.agent_profile_tab, icon: UserRound },
  reminders: { label: m.agent_reminders_tab, icon: Bell },
  activity: { label: m.agent_activity_tab, icon: ActivityIcon },
  workspace: { label: m.agent_workspace_tab, icon: Folder },
};

/** The tabs this viewer may see, in their saved order; the first one is the panel's default. */
export function useAgentProfileTabOrder(canSeeManagerTabs: boolean, canSeeWorkspace: boolean) {
  return usePanelTabOrder(
    "agentProfile",
    visibleAgentProfileTabs(canSeeManagerTabs, canSeeWorkspace),
  );
}

/**
 * The panel's second band (44px, same as the conversation's Chat/Tasks band): the same
 * reorderable icon + label tab strip `ConversationTaskTabs` uses.
 */
export function AgentProfileTabs({
  active,
  tabs,
  onSelect,
  onReorder,
}: {
  active: AgentProfileTab;
  tabs: AgentProfileTab[];
  onSelect: (tab: AgentProfileTab) => void;
  onReorder: (order: AgentProfileTab[]) => void;
}) {
  return (
    <ReorderableTabStrip
      aria-label={m.agent_profile_panel_tabs()}
      // Borderless tab strip: the -ml-3 cancels the first button's px-3 so its icon lands on the
      // panel gutter (docs/design.md §8 optical alignment).
      className="-ml-3 w-max shrink-0"
      tabs={tabs}
      meta={TABS}
      active={active}
      onSelect={onSelect}
      onReorder={onReorder}
    />
  );
}
