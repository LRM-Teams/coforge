import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { m } from "#src/paraglide/messages";

import {
  readLiveAgentActivity,
  subscribeLiveAgentActivity,
} from "#src/features/settings/live-agent-activity";

import { selectLiveAgentActivity, type LiveAgentActivityCandidate } from "./live-agent-activity";
import { useCloseConversationList } from "./conversation-navigation";

/**
 * Latest notable Agent work, pinned under the chat list. Idle and offline
 * Agents stay in the list above; this row only appears while someone is
 * working, thinking, or in error. Activity wording stays in English.
 */
export function LiveAgentActivityBar({
  agents,
}: {
  agents: readonly LiveAgentActivityCandidate[];
}) {
  const activity = selectLiveAgentActivity(agents);
  const closeList = useCloseConversationList();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    const sync = () => setEnabled(readLiveAgentActivity());
    sync();
    return subscribeLiveAgentActivity(sync);
  }, []);
  if (!enabled || !activity) return null;

  return (
    <div className="shrink-0 border-t border-secondary bg-primary px-3 py-2">
      <Link
        to="/messages/$agentId"
        params={{ agentId: activity.agentId }}
        onClick={closeList}
        aria-label={`${activity.displayName}, ${activity.label}`}
        className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <AgentDisplayAvatar
          name={activity.displayName}
          src={activity.avatarUrl}
          display={activity.display}
          size="xs"
        />
        <span className="min-w-0 flex-1 truncate text-xs text-secondary">
          <span className="font-medium text-primary">{activity.displayName}</span>
          <span className="text-tertiary"> {activity.label}</span>
        </span>
        <span className="sr-only">{m.messages_live_activity()}</span>
      </Link>
    </div>
  );
}
