import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { listAgents, getAgentStatusSubscriptionToken } from "./agents.functions";
import { useAgentStatuses, type AgentStatusView } from "./agent-status-realtime";
import type { ActivityEntry } from "./agent-activity";
import {
  agentActivityFeedQuery,
  useWorkspaceActivityRealtime,
  workspaceActivityQuery,
} from "./agent-activity-queries";

const EMPTY_ACTIVITY: ActivityEntry[] = [];

export type LiveAgent = {
  id: string;
  name: string;
  displayName: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
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
  useWorkspaceActivityRealtime(workspaceId);
  const visibleAgents = useAgentStatuses({
    agents,
    workspaceId,
    refresh: refreshAgents,
    getConnectionToken: getStatusToken,
  });
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
