import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { agentDisplay } from "@/features/agents/agent-activity-presentation";
import type { StatusTone } from "@/components/ui/status-dot";

export type LiveAgentActivityCandidate = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  display?: AgentDisplaySnapshot;
};

export type LiveAgentActivity = {
  agentId: string;
  displayName: string;
  avatarUrl: string | null;
  label: string;
  tone: StatusTone;
  pulse: boolean;
  /** The selected snapshot, so the strip can reuse the directory avatar. */
  display: AgentDisplaySnapshot;
};

const NOTABLE = new Set(["working", "thinking", "error"]);

/**
 * The one Agent whose current work belongs in the chat-list activity strip.
 * Idle, offline, and unknown displays stay out: the strip is for work in
 * progress, not a second presence list. Among notable displays, the highest
 * cloud revision wins; an equal revision keeps the earlier candidate so a
 * republish does not swap the row.
 */
export function selectLiveAgentActivity(
  agents: readonly LiveAgentActivityCandidate[],
): LiveAgentActivity | null {
  let selected: LiveAgentActivity | null = null;
  let revision = -1;
  for (const agent of agents) {
    if (!agent.display || !NOTABLE.has(agent.display.activityKind)) continue;
    if (agent.display.revision < revision) continue;
    if (agent.display.revision === revision && selected) continue;
    const view = agentDisplay(agent.display);
    selected = {
      agentId: agent.id,
      displayName: agent.displayName,
      avatarUrl: agent.avatarUrl ?? null,
      label: view.label,
      tone: view.tone,
      pulse: view.pulse,
      display: agent.display,
    };
    revision = agent.display.revision;
  }
  return selected;
}
