import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { getAgentProfile } from "../agents.functions";
import { agentActivityFeedQuery } from "../agent-activity-queries";
import { mergeAgentActivity } from "../agent-activity";

const agentProfileKey = (agentId: string) => ["agent-profile", agentId] as const;

/** The Agent profile panel's own data seam: a light server read shared by the Members
 * directory panel and every conversation panel. */
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

/**
 * Re-fetches every surface that still shows this Agent after a panel edit.
 * The panel itself is query-cached (`agent-profile`); the DM list and conversation
 * header come from the `/_app` loader (`listAgents` → LiveAgents); message
 * `senderName` lives on the conversation query. The full Agent detail page uses
 * `router.invalidate` for the loader; settings avatar upload also invalidates
 * `["conversation"]` so already-open threads pick up the new identity.
 */
export function useInvalidateAgentProfile(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    if (!agentId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: agentProfileKey(agentId) }),
      queryClient.invalidateQueries({ queryKey: ["conversation"] }),
      router.invalidate({ sync: true }),
    ]);
  };
}
