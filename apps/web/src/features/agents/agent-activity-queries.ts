import { queryOptions, skipToken, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getAgentActivityFeed, getWorkspaceActivity } from "./agent-activity.functions";
import { getAgentActivitySubscriptionToken } from "./agents.functions";
import {
  agentActivityChannel,
  decodeActivityObservation,
  mergeAgentActivity,
  POPOVER_EXCLUDED_DETAIL_KINDS,
  RECENT_ACTIVITY_LIMIT,
  type ActivityEntry,
} from "./agent-activity";
import { useRealtimeSubscription } from "../realtime/browser-realtime";

export const agentActivityKeys = {
  all: ["agent-activity"] as const,
  workspace: (workspaceId: string | undefined) =>
    ["agent-activity", "workspace", workspaceId ?? null] as const,
  agent: (agentId: string) => ["agent-activity", "agent", agentId] as const,
};

export type RecentActivityByAgent = Record<string, ActivityEntry[]>;

// Shared by the queryFn's per-agent merge and the publication patch, so both
// sides of the cache apply the same merge and the same cap. Also keeps this
// short "recent activity" cache free of the ordinary status rows the Agent
// detail feed now shows (tool_end/thinking_end/compaction_finished; ADR
// 0021, amended) — filtered here, upstream of the cap, so a run of those
// doesn't crowd out the popover's genuinely noteworthy events.
const mergeRecent = (current: ActivityEntry[] | undefined, incoming: ActivityEntry[]) =>
  mergeAgentActivity(
    current ?? [],
    incoming.filter((entry) => !POPOVER_EXCLUDED_DETAIL_KINDS.has(entry.detailKind)),
  ).slice(0, RECENT_ACTIVITY_LIMIT);

// Realtime keeps these entries current, so they never go stale by age. Query's
// focus manager refetches when the tab becomes visible again (`visibilitychange`)
// and when the network returns, in case a push was missed while hidden or offline.
const realtimeBackedQueryOptions = {
  staleTime: Infinity,
  refetchOnWindowFocus: "always",
  refetchOnReconnect: "always",
} as const;

/**
 * One Workspace's recent Activity per Agent (newest first, capped at
 * RECENT_ACTIVITY_LIMIT). The sidebar and every open avatar read this same
 * cache entry instead of subscribing themselves.
 */
export const workspaceActivityQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: agentActivityKeys.workspace(workspaceId),
    ...realtimeBackedQueryOptions,
    queryFn: workspaceId
      ? async ({ client, queryKey }) => {
          const snapshot = await getWorkspaceActivity();
          if (snapshot.workspaceId !== workspaceId) throw new Error("Workspace changed");
          // A publication can land while this snapshot is in flight; merge onto
          // whatever is cached right now instead of overwriting it.
          const current = client.getQueryData<RecentActivityByAgent>(queryKey) ?? {};
          // The snapshot lists every authorized Agent, so one missing from it is gone.
          const next: RecentActivityByAgent = {};
          for (const agent of snapshot.agents)
            next[agent.id] = mergeRecent(current[agent.id], agent.activity);
          return next;
        }
      : skipToken,
  });

/** The Agent detail Activity tab's feed (up to 500 rows, newest first). */
export const agentActivityFeedQuery = (agentId: string) =>
  queryOptions({
    queryKey: agentActivityKeys.agent(agentId),
    ...realtimeBackedQueryOptions,
    queryFn: async ({ client, queryKey }) => {
      const rows = await getAgentActivityFeed({ data: agentId });
      const current = client.getQueryData<ActivityEntry[]>(queryKey) ?? [];
      return mergeAgentActivity(current, rows);
    },
  });

/**
 * The app shell's one Activity subscription. Every (re)subscribe invalidates
 * both query shapes so a gap left by a disconnect is closed by a refetch;
 * publications in between patch the cache directly.
 */
export function useWorkspaceActivityRealtime(workspaceId?: string) {
  const queryClient = useQueryClient();
  const getConnectionToken = useServerFn(getAgentActivitySubscriptionToken);

  useRealtimeSubscription({
    channel: workspaceId ? agentActivityChannel(workspaceId) : undefined,
    getToken: getConnectionToken,
    onSubscribed: () => void queryClient.invalidateQueries({ queryKey: agentActivityKeys.all }),
    onPublication: (publication) => {
      if (!workspaceId) return;
      const observation = decodeActivityObservation(publication.data, { workspaceId });
      if (!observation) return;
      const { agentId, entry } = observation;
      const key = agentActivityKeys.workspace(workspaceId);
      const seeded = queryClient.getQueryData(key) !== undefined;
      queryClient.setQueryData<RecentActivityByAgent>(key, (current = {}) => ({
        ...current,
        [agentId]: mergeRecent(current[agentId], [entry]),
      }));
      // A publication that beat the first snapshot must not stand in for the whole
      // history: invalidate so the snapshot still loads and merges onto it.
      if (!seeded) void queryClient.invalidateQueries({ queryKey: key });
      // Only patches a feed tab that is already cached; the route loader seeds
      // it, and an uncached feed has no reader to patch here.
      queryClient.setQueryData(
        agentActivityFeedQuery(agentId).queryKey,
        (current: ActivityEntry[] | undefined) => current && mergeAgentActivity(current, [entry]),
      );
    },
  });
}
