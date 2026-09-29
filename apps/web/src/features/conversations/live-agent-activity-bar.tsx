import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button as AriaButton } from "react-aria-components";

import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";

import {
  readLiveAgentActivity,
  subscribeLiveAgentActivity,
} from "#src/features/settings/live-agent-activity";

import { selectLiveAgentActivity, type LiveAgentActivityCandidate } from "./live-agent-activity";
import { useCloseConversationList } from "./conversation-navigation";
import { useOpenDirectConversation } from "./open-direct-conversation";

/**
 * Latest notable Agent work, pinned under the chat list. Idle and offline
 * Agents stay in the list above; this row only appears while someone is
 * working, thinking, or in error. Activity wording stays in English.
 */
export function LiveAgentActivityBar({
  agents,
  agentDms,
}: {
  agents: readonly LiveAgentActivityCandidate[];
  /** The viewer's DM with each of their Agents, by Agent. The roster is the viewer's own Agents,
   * so the row opens the Agent's DM, starting it when there is none yet. */
  agentDms: ReadonlyMap<string, string>;
}) {
  const activity = selectLiveAgentActivity(agents);
  const closeList = useCloseConversationList();
  const workspaceSlug = useWorkspaceSlug();
  const openDirectConversation = useOpenDirectConversation();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    const sync = () => setEnabled(readLiveAgentActivity());
    sync();
    return subscribeLiveAgentActivity(sync);
  }, []);
  if (!enabled || !activity) return null;
  const dmId = agentDms.get(activity.agentId);
  const className =
    "flex min-w-0 items-center gap-2 rounded-md px-1 py-1 outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2";
  const content = (
    <>
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
    </>
  );

  return (
    <div className="shrink-0 border-t border-secondary bg-primary px-3 py-2">
      {dmId ? (
        <Link
          to="/w/$workspaceSlug/dm/$dmId"
          params={{ workspaceSlug, dmId }}
          onClick={closeList}
          aria-label={`${activity.displayName}, ${activity.label}`}
          className={className}
        >
          {content}
        </Link>
      ) : (
        <AriaButton
          onPress={() => {
            closeList();
            void openDirectConversation({ agentId: activity.agentId });
          }}
          aria-label={`${activity.displayName}, ${activity.label}`}
          className={`w-full text-left ${className}`}
        >
          {content}
        </AriaButton>
      )}
    </div>
  );
}
