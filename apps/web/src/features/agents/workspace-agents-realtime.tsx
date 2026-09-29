import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { createStore, useSelector, type Store } from "@tanstack/react-store";
import { usePrefetchQuery, useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { useSyncedStore } from "#src/hooks/use-synced-store";

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
import { agentModelsQueryKey } from "./agent-models";

const EMPTY_ACTIVITY: ActivityEntry[] = [];

export type LiveAgent = {
  id: string;
  name: string;
  displayName: string;
  avatarUrl?: string | null;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
  /** Optional: an Agent shape that predates this field (or came from a path that never
   * set it) reads as `"public"`, matching the same fail-open default the create/list paths use
   * for Agents created before visibility existed. */
  visibility?: AgentVisibility;
  /** Set only on a placeholder standing in for an Agent visible to the viewer but
   * outside their own `listAgents` roster (`extraAgentPlaceholder`) — no real name/description,
   * so `useLiveAgents()` (the Members directory, DM sidebar, mention list) filters it out;
   * `useLiveAgent(id)` still returns it so the profile panel gets its live status/Activity. */
  isExtra?: true;
};

// Both contexts are module-private: everything outside reads them through the
// hooks below, so a consumer can never reach in and subscribe on its own. The live Agents are a
// TanStack Store rather than a context value, so a reader of one Agent (a message's avatar) is
// told when that Agent changes and not when any other does.
const LiveAgentStoreContext = createContext<Store<LiveAgent[]>>(createStore<LiveAgent[]>([]));
const WorkspaceIdContext = createContext<string | undefined>(undefined);

const visiblePrivateAgentIdsKey = (workspaceId: string | undefined) =>
  ["agent-visibility", "visible-private-ids", workspaceId ?? null] as const;

/** Realtime gap: a placeholder `LiveAgent` for an Agent visible to the viewer but
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

  // Realtime gap: ids of private Agents visible to this viewer beyond their own
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
      ? () => {
          void queryClient.invalidateQueries({ queryKey: visiblePrivateAgentIdsKey(workspaceId) });
          // A model label follows the Agent's visibility too (`agent-models.ts`).
          void queryClient.invalidateQueries({ queryKey: agentModelsQueryKey(workspaceId) });
        }
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

  // An Agent no longer visible to this viewer (dropped by `mergeAgentStatusSnapshot`
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

  const liveAgents = useSyncedStore(visibleAgents);

  return (
    <LiveAgentStoreContext value={liveAgents}>
      <WorkspaceIdContext value={workspaceId}>{children}</WorkspaceIdContext>
    </LiveAgentStoreContext>
  );
}

/** Whether an Agent is in the viewer's own roster, not an `isExtra` placeholder. */
function inRoster(agent: { isExtra?: true }) {
  return !agent.isExtra;
}

/** The live Agent list (with realtime status), for the sidebar's Direct message section. */
/** The Members directory / DM sidebar / mention list roster: never includes an `isExtra`
 * placeholder, since those carry no real name/description and exist only so
 * `useLiveAgent(id)` can serve live status/Activity for an Agent outside the viewer's own
 * roster. */
export function useLiveAgents(): LiveAgent[] {
  const agents = useSelector(useContext(LiveAgentStoreContext), (state) => state);
  // One list per store value, not per call: consumers memoize on it, and a fresh array on every
  // render would invalidate all of them.
  return useMemo(() => agents.filter(inRoster), [agents]);
}

/** Each live Agent's latest display by id, for avatars' status dots. */
export function useAgentDisplays(): Map<string, AgentDisplaySnapshot | undefined> {
  const agents = useLiveAgents();
  return useMemo(() => new Map(agents.map((agent) => [agent.id, agent.display])), [agents]);
}

/** The current Workspace id from the app shell's providers, when one is selected. */
export function useCurrentWorkspaceId(): string | undefined {
  return useContext(WorkspaceIdContext);
}

/** One Agent's live status and display snapshot, for pages open on that Agent. */
export function useLiveAgent(agentId: string): LiveAgent | undefined {
  return useSelector(useContext(LiveAgentStoreContext), (agents) =>
    agents.find((agent) => agent.id === agentId),
  );
}

/** One live Agent's display, or nothing for an Agent not in the viewer's roster (an `isExtra`
 * placeholder, as `useLiveAgents` leaves out) or not live here. */
export function liveAgentDisplay(
  agents: readonly { id: string; display?: AgentDisplaySnapshot; isExtra?: true }[],
  agentId: string,
): AgentDisplaySnapshot | undefined {
  return agents.find((agent) => agent.id === agentId && inRoster(agent))?.display;
}

/**
 * One Agent's display, for its avatar's status dot: repaints when that Agent's display changes
 * and not on another Agent's change or on a status lease refresh.
 */
export function useLiveAgentDisplay(agentId: string): AgentDisplaySnapshot | undefined {
  return useSelector(useContext(LiveAgentStoreContext), (agents) =>
    liveAgentDisplay(agents, agentId),
  );
}

/** One Agent's recent activity (≤5, newest first), for the Agent card. */
export function useAgentRecentActivity(agentId: string): ActivityEntry[] {
  const workspaceId = useContext(WorkspaceIdContext);
  const query = useQuery({
    ...workspaceActivityQuery(workspaceId),
    select: (data) => data[agentId] ?? EMPTY_ACTIVITY,
  });
  return query.data ?? EMPTY_ACTIVITY;
}

/** The profile panel's Activity tab feed, kept live by the shared subscription. */
export function useAgentActivityFeed(agentId: string) {
  return useQuery(agentActivityFeedQuery(agentId));
}

/** Starts loading an Agent's Activity feed without re-rendering the caller on each frame, so the
 * Activity tab is usually ready by the time it is selected. */
export function usePrefetchAgentActivityFeed(agentId: string) {
  usePrefetchQuery(agentActivityFeedQuery(agentId));
}
