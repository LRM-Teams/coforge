import { MEMBER_DIRECTORY_KEY } from "@/features/agents/member-directory-queries";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { getAgentEnvironment, getAgentProfile } from "../agents.functions";
import { agentActivityFeedQuery } from "../agent-activity-queries";
import { mergeAgentActivity } from "../agent-activity";

const agentProfileKey = (agentId: string) => ["agent-profile", agentId] as const;
export const agentEnvironmentKey = (agentId: string) => ["agent-environment", agentId] as const;

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
 * The RUNTIME CONFIG section's masked env chips and the Runtime config dialog's Advanced rows
 * share this one load: owner-only (the GET itself enforces it; `enabled` just avoids firing the
 * request for a viewer who can never get anything back), short `staleTime` since it reflects a
 * value that can change from another surface (`ADR 0038`'s deferred-save + external restart).
 */
export function agentEnvironmentQuery(agentId: string | undefined, enabled: boolean) {
  return queryOptions({
    queryKey: agentEnvironmentKey(agentId ?? ""),
    queryFn: async () => getAgentEnvironment({ data: agentId! }),
    enabled: Boolean(agentId) && enabled,
    staleTime: 15_000,
  });
}

/**
 * Re-fetches every surface that still shows this Agent after a panel edit.
 * The panel itself is query-cached (`agent-profile`); the DM list and conversation
 * header come from the `/_app` loader (`listAgents` → LiveAgents); message
 * `senderName` lives on the conversation query; the Members grid lives on `member-directory`. The full Agent detail page uses
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
      // The Members grid pages its cards through the Query cache, not the route loader.
      queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY }),
      router.invalidate({ sync: true }),
    ]);
  };
}
