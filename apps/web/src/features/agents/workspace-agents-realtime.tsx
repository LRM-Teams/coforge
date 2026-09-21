import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import {
  listAgents,
  getAgentActivitySubscriptionTokenForAgent,
  getAgentStatusSubscriptionToken,
  getAgentStatusSubscriptionTokenForAgent,
} from "./agents.functions";
import { useAgentStatuses, type AgentStatusView } from "./agent-status-realtime";
import type { ActivityEntry } from "./agent-activity";
import { AGENT_VISIBILITY, type AgentVisibility } from "./agent-visibility";
import {
  agentActivityFeedQuery,
  useWorkspaceActivityRealtime,
  workspaceActivityQuery,
  type RecentActivityByAgent,
} from "./agent-activity-queries";

const EMPTY_ACTIVITY: ActivityEntry[] = [];

export type LiveAgent = {
  id: string;
  name: string;
  displayName: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
  /** ADR 0059. Optional: an Agent shape that predates this field (or came from a path that never
   * set it) reads as `"public"`, matching the same fail-open default the create/list paths use
   * before this ADR existed. */
  visibility?: AgentVisibility;
};

// Both contexts are module-private: everything outside reads them through the
// hooks below, so a consumer can never reach in and subscribe on its own.
const LiveAgentsContext = createContext<LiveAgent[]>([]);
const WorkspaceIdContext = createContext<string | undefined>(undefined);

/**
 * Owns the app shell's one Agent status subscription and one Activity
 * subscription, and shares both through context. Must be rendered inside
 * `BrowserRealtimeProvider` — the subscription hooks it calls throw when no
 * realtime client is above them — so mounting it anywhere else fails loudly
 * instead of silently never subscribing.
 */
export function WorkspaceAgentsProvider({
  workspaceId,
  agents,
  children,
}: {
  workspaceId?: string;
  agents: LiveAgent[];
  children: ReactNode;
}) {
  const refreshAgents = useServerFn(listAgents);
  const getStatusToken = useServerFn(getAgentStatusSubscriptionToken);
  const getPrivateActivityToken = useServerFn(getAgentActivitySubscriptionTokenForAgent);
  const getPrivateStatusToken = useServerFn(getAgentStatusSubscriptionTokenForAgent);
  const queryClient = useQueryClient();

  // ADR 0059: one render behind `visibleAgents` by construction (the ref is written after this
  // render's hooks run, from `visibleAgents` — the state the hooks below themselves produce), and
  // self-correcting on the very next state update, since a new value here only ever needs a
  // resubscribe, never a synchronous read of the current one.
  const privateAgentIdsRef = useRef<string[]>(
    agents
      .filter((agent) => agent.visibility === AGENT_VISIBILITY.PRIVATE)
      .map((agent) => agent.id),
  );

  useWorkspaceActivityRealtime(
    workspaceId,
    privateAgentIdsRef.current,
    workspaceId ? (agentId) => getPrivateActivityToken({ data: { agentId } }) : undefined,
  );
  const visibleAgents = useAgentStatuses({
    agents,
    workspaceId,
    refresh: refreshAgents,
    getConnectionToken: getStatusToken,
    privateAgentIds: privateAgentIdsRef.current,
    getPrivateAgentStatusToken: workspaceId
      ? (agentId) => getPrivateStatusToken({ data: { agentId } })
      : undefined,
  });
  privateAgentIdsRef.current = visibleAgents
    .filter((agent) => agent.visibility === AGENT_VISIBILITY.PRIVATE)
    .map((agent) => agent.id);

  // ADR 0059: an Agent no longer visible to this viewer (dropped by `mergeAgentStatusSnapshot`
  // from the fresh `refresh()` list, e.g. after `agent:visibility_changed`) must not leave its
  // recent-activity entry behind in the shared cache.
  useEffect(() => {
    if (!workspaceId) return;
    const visibleIds = new Set(visibleAgents.map((agent) => agent.id));
    queryClient.setQueryData<RecentActivityByAgent>(
      workspaceActivityQuery(workspaceId).queryKey,
      (current) => {
        if (!current) return current;
        let changed = false;
        const next: RecentActivityByAgent = {};
        for (const [agentId, entries] of Object.entries(current)) {
          if (visibleIds.has(agentId)) next[agentId] = entries;
          else changed = true;
        }
        return changed ? next : current;
      },
    );
  }, [visibleAgents, workspaceId, queryClient]);

  return (
    <LiveAgentsContext value={visibleAgents}>
      <WorkspaceIdContext value={workspaceId}>{children}</WorkspaceIdContext>
    </LiveAgentsContext>
  );
}

/** The live Agent list (with realtime status), for the sidebar's Direct message section. */
export function useLiveAgents(): LiveAgent[] {
  return useContext(LiveAgentsContext);
}

/** The current Workspace id from the app shell's providers, when one is selected. */
export function useCurrentWorkspaceId(): string | undefined {
  return useContext(WorkspaceIdContext);
}

/** One Agent's live status and display snapshot, for pages open on that Agent. */
export function useLiveAgent(agentId: string): LiveAgent | undefined {
  return useContext(LiveAgentsContext).find((agent) => agent.id === agentId);
}

/** One Agent's recent activity (≤5, newest first), for its avatar popover. */
export function useAgentRecentActivity(agentId: string) {
  const workspaceId = useContext(WorkspaceIdContext);
  const query = useQuery({
    ...workspaceActivityQuery(workspaceId),
    select: (data) => data[agentId] ?? EMPTY_ACTIVITY,
  });
  const activity = query.data ?? EMPTY_ACTIVITY;
  return {
    activity,
    // Without a workspaceId the query is disabled via skipToken, which also
    // reads as isPending, so the caller needs the guard to tell them apart.
    loading: query.isPending && Boolean(workspaceId),
    error: query.isError && activity.length === 0,
  };
}

/** The Agent detail Activity tab's feed, kept live by the shared subscription. */
export function useAgentActivityFeed(agentId: string) {
  return useQuery(agentActivityFeedQuery(agentId)).data;
}
