import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { getAgentProfile } from "../agents.functions";
import { agentActivityFeedQuery } from "../agent-activity-queries";
import { mergeAgentActivity } from "../agent-activity";

const agentProfileKey = (agentId: string) => ["agent-profile", agentId] as const;

/** The Agent profile panel's own data seam (see `AGENTS.md`'s "reuse `AgentDetailQuery`
 * pieces... do NOT run the full detail loader"): a light server read, not the `/agents/$agentId`
 * route's `getAgentDetail` + `listComputers` + `getUserPreferences` combination. */
export function agentProfileQuery(agentId: string | undefined) {
  return queryOptions({
    queryKey: agentProfileKey(agentId ?? ""),
    queryFn: async () => getAgentProfile({ data: agentId! }),
    enabled: Boolean(agentId),
    staleTime: 15_000,
  });
}

/**
 * Loads the panel's profile payload and, on arrival, seeds the shared Activity feed cache
 * (`agent-activity-queries.ts`'s `agentActivityFeedQuery`) exactly like the full Agent detail
 * route's loader does — so the Activity tab and the live `useAgentActivityFeed` subscription see
 * the same history whichever surface opened first.
 */
export function useAgentProfileData(agentId: string | undefined) {
  const query = useQuery(agentProfileQuery(agentId));
  const queryClient = useQueryClient();
  const activity = query.data?.activity;
  useEffect(() => {
    if (!agentId || !activity) return;
    queryClient.setQueryData(agentActivityFeedQuery(agentId).queryKey, (current) =>
      mergeAgentActivity(current ?? [], activity),
    );
  }, [agentId, activity, queryClient]);
  return query;
}

/** Re-fetches the panel's own data after a control action or an edit; the full Agent detail page
 * uses `router.invalidate` for the same purpose, but the panel is not route-loaded data. */
export function useInvalidateAgentProfile(agentId: string | undefined) {
  const queryClient = useQueryClient();
  return () =>
    agentId ? queryClient.invalidateQueries({ queryKey: agentProfileKey(agentId) }) : undefined;
}
