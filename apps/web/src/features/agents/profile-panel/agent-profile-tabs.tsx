import {
  Activity as ActivityIcon,
  Bell01 as Bell,
  UserCircle as UserRound,
} from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import type { AgentProfileTab } from "./profile-panel-search";

/**
 * The panel's second band (44px, same as the conversation's Chat/Tasks band): tabs with icon +
 * label, reusing the exact `Button` variant/classes `ConversationTaskTabs`
 * (`features/tasks/conversation-task-tabs.tsx`) uses for Chat/Tasks — that component is a plain
 * `<Button color={active ? "secondary" : "tertiary"}>` row, not a Link-based nav, so this mirrors
 * it directly rather than reusing that component (which is conversation-specific and untyped for
 * a third tab set). Profile, Reminders and Activity; Reminders and Activity are both
 * manager/owner-only.
 */
export function AgentProfileTabs({
  active,
  showManagerTabs,
  onSelect,
}: {
  active: AgentProfileTab;
  /** Non-managers (see the brief's Permissions section) see Profile only. */
  showManagerTabs: boolean;
  onSelect: (tab: AgentProfileTab) => void;
}) {
  return (
    <nav aria-label={m.agent_profile_panel_tabs()} className="flex items-center gap-1">
      <Button
        type="button"
        color={active === "profile" ? "secondary" : "tertiary"}
        size="sm"
        aria-current={active === "profile" ? "page" : undefined}
        iconLeading={UserRound}
        onPress={() => onSelect("profile")}
      >
        {m.agent_profile_tab()}
      </Button>
      {showManagerTabs && (
        <Button
          type="button"
          color={active === "reminders" ? "secondary" : "tertiary"}
          size="sm"
          aria-current={active === "reminders" ? "page" : undefined}
          iconLeading={Bell}
          onPress={() => onSelect("reminders")}
        >
          {m.agent_reminders_tab()}
        </Button>
      )}
      {showManagerTabs && (
        <Button
          type="button"
          color={active === "activity" ? "secondary" : "tertiary"}
          size="sm"
          aria-current={active === "activity" ? "page" : undefined}
          iconLeading={ActivityIcon}
          onPress={() => onSelect("activity")}
        >
          {m.agent_activity_tab()}
        </Button>
      )}
    </nav>
  );
}
