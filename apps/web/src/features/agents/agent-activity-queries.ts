import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getWorkspaceActivity } from "./agent-activity.functions";
import { getAgentActivitySubscriptionToken, getAgentDetail } from "./agents.functions";
import {
  agentActivityChannel,
  decodeActivityObservation,
  mergeAgentActivity,
  type ActivityEntry,
} from "./agent-activity";
import { useRealtimeSubscription } from "../realtime/browser-realtime";

// Realtime keeps these entries current, so they never go stale by age. A tab
// coming back into view or the network returning refetches anyway: pushes may
// have been missed while the page was hidden or offline.
const liveQuery = {
  staleTime: Infinity,
  refetchOnWindowFocus: "always",
  refetchOnReconnect: "always",
} as const;

/**
 * One Workspace's recent Activity per Agent (newest first, capped at 5 — the
 * avatar popover's limit). The sidebar and every open avatar read this same
 * cache entry instead of subscribing themselves.
 */
export const workspaceActivityQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["agent-activity", "workspace", workspaceId] as const,
    ...liveQuery,
    queryFn: async ({ client, queryKey }) => {
      const snapshot = await getWorkspaceActivity();
      if (snapshot.workspaceId !== workspaceId) throw new Error("Workspace changed");
      // A publication can land while this snapshot is in flight; merge onto
      // whatever is cached right now instead of overwriting it.
      const current = client.getQueryData<Record<string, ActivityEntry[]>>(queryKey) ?? {};
      const next: Record<string, ActivityEntry[]> = { ...current };
      for (const agent of snapshot.agents)
        next[agent.id] = mergeAgentActivity(current[agent.id] ?? [], agent.activity).slice(0, 5);
      return next;
    },
  });

/** The Agent detail Activity tab's feed (up to 100 rows, newest first). */
export const agentActivityFeedQuery = (agentId: string) =>
  queryOptions({
    queryKey: ["agent-activity", "agent", agentId] as const,
    ...liveQuery,
    queryFn: async ({ client, queryKey }) => {
      const detail = await getAgentDetail({ data: agentId });
      const current = client.getQueryData<ActivityEntry[]>(queryKey) ?? [];
      return mergeAgentActivity(current, detail.activity);
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
    onSubscribed: () => void queryClient.invalidateQueries({ queryKey: ["agent-activity"] }),
    onPublication: (publication) => {
      if (!workspaceId) return;
      const observation = decodeActivityObservation(publication.data, { workspaceId });
      if (!observation) return;
      const { agentId, entry } = observation;
      queryClient.setQueryData(
        workspaceActivityQuery(workspaceId).queryKey,
        (current: Record<string, ActivityEntry[]> | undefined) =>
          current && {
            ...current,
            [agentId]: mergeAgentActivity(current[agentId] ?? [], [entry]).slice(0, 5),
          },
      );
      // Only patches a feed tab that is already open/cached; nothing seeds it here.
      queryClient.setQueryData(
        agentActivityFeedQuery(agentId).queryKey,
        (current: ActivityEntry[] | undefined) => current && mergeAgentActivity(current, [entry]),
      );
    },
  });
}
