import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import {
  listAgents,
  getAgentActivitySubscriptionTokenForAgent,
  getAgentStatusSubscriptionToken,
  getAgentStatusSubscriptionTokenForAgent,
  listVisiblePrivateAgentIds,
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
  avatarUrl?: string | null;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
  /** ADR 0059. Optional: an Agent shape that predates this field (or came from a path that never
   * set it) reads as `"public"`, matching the same fail-open default the create/list paths use
   * before this ADR existed. */
  visibility?: AgentVisibility;
  /** ADR 0059: set only on a placeholder standing in for an Agent visible to the viewer but
   * outside their own `listAgents` roster (`extraAgentPlaceholder`) — no real name/description,
   * so `useLiveAgents()` (the Members directory, DM sidebar, mention list) filters it out;
   * `useLiveAgent(id)` still returns it so the profile panel gets its live status/Activity. */
  isExtra?: true;
};

// Both contexts are module-private: everything outside reads them through the
// hooks below, so a consumer can never reach in and subscribe on its own.
const LiveAgentsContext = createContext<LiveAgent[]>([]);
const WorkspaceIdContext = createContext<string | undefined>(undefined);

const visiblePrivateAgentIdsKey = (workspaceId: string | undefined) =>
  ["agent-visibility", "visible-private-ids", workspaceId ?? null] as const;

/** ADR 0059 realtime gap: a placeholder `LiveAgent` for an Agent visible to the viewer but
 * outside their own `listAgents` roster (e.g. an owner/admin viewing another member's private
 * Agent) — "inactive" until a live per-Agent publication says otherwise, matching `listAgents`'s
 * own "nothing heard yet" default. Its name/description are blank; any surface reading it (the
 * profile panel) already prefers its own authorized `getAgentProfile` fetch for those fields. */
function extraAgentPlaceholder(id: string): LiveAgent {
  return {
    id,
    name: "",
    displayName: "",
    visibility: AGENT_VISIBILITY.PRIVATE,
    status: { value: "inactive", expiresAt: null },
    isExtra: true,
  };
}

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
  const getVisiblePrivateIds = useServerFn(listVisiblePrivateAgentIds);
  const queryClient = useQueryClient();

  // ADR 0059 realtime gap: ids of private Agents visible to this viewer beyond their own
  // `listAgents` roster (an owner/admin, or a private Agent's creator viewing it from outside
  // their own roster). Refetched on `agent:visibility_changed` below (a viewer gaining or losing
  // sight of an already-existing Agent); refetching on focus/reconnect also catches a private
  // Agent CREATED by someone else meanwhile, since creation has no dedicated realtime signal.
  const visiblePrivateIdsQuery = useQuery({
    queryKey: visiblePrivateAgentIdsKey(workspaceId),
    queryFn: workspaceId ? () => getVisiblePrivateIds() : skipToken,
    staleTime: Infinity,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const ownAgentIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  const extraAgents = useMemo(
    () =>
      (visiblePrivateIdsQuery.data ?? [])
        .filter((id) => !ownAgentIds.has(id))
        .map(extraAgentPlaceholder),
    [visiblePrivateIdsQuery.data, ownAgentIds],
  );

  // `useAgentStatuses` derives its own per-Agent status subscriptions from its own current
  // state (see agent-status-realtime.ts), so a freshly-private Agent is subscribed the moment
  // it learns about it — no lag from an external, previous-render list.
  const visibleAgents = useAgentStatuses<LiveAgent>({
    agents,
    workspaceId,
    refresh: refreshAgents,
    getConnectionToken: getStatusToken,
    extraAgents,
    onVisibilityChangedEvent: workspaceId
      ? () =>
          void queryClient.invalidateQueries({ queryKey: visiblePrivateAgentIdsKey(workspaceId) })
      : undefined,
    getPrivateAgentStatusToken: workspaceId
      ? (agentId) => getPrivateStatusToken({ data: { agentId } })
      : undefined,
  });

  // Same-render derivation from the fresh `visibleAgents` state `useAgentStatuses` just
  // produced (not a previous-render ref), so the Activity subscription set never lags behind
  // the status one.
  const privateAgentIds = useMemo(
    () =>
      visibleAgents
        .filter((agent) => agent.visibility === AGENT_VISIBILITY.PRIVATE)
        .map((agent) => agent.id),
    [visibleAgents],
  );
  useWorkspaceActivityRealtime(
    workspaceId,
    privateAgentIds,
    workspaceId ? (agentId) => getPrivateActivityToken({ data: { agentId } }) : undefined,
  );

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
/** The Members directory / DM sidebar / mention list roster: never includes an `isExtra`
 * placeholder (ADR 0059), since those carry no real name/description and exist only so
 * `useLiveAgent(id)` can serve live status/Activity for an Agent outside the viewer's own
 * roster. */
export function useLiveAgents(): LiveAgent[] {
  return useContext(LiveAgentsContext).filter((agent) => !agent.isExtra);
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
