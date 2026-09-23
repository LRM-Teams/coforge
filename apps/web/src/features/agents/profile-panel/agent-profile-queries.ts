import { MEMBER_DIRECTORY_KEY } from "#src/features/agents/member-directory-queries";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { getAgentEnvironment, getAgentProfile } from "#src/features/agents/agents.functions";

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

/** Loads the panel's profile payload. Activity history is not in it; the Activity tab reads the
 * shared feed through `useAgentActivityFeed`. */
export function useAgentProfileData(agentId: string | undefined) {
  return useQuery(agentProfileQuery(agentId));
}

/**
 * The RUNTIME CONFIG section's masked env chips and the Runtime config dialog's Advanced rows
 * share this one load: owner-only (the GET itself enforces it; `enabled` just avoids firing the
 * request for a viewer who can never get anything back), short `staleTime` since it reflects a
 * value that can change from another surface (deferred save + external restart).
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
