import { useEffect, useRef, useState } from "react";
import {
  decodeActivityObservation,
  agentActivityChannel,
  mergeAgentActivity,
  type ActivityEntry,
} from "./agent-activity";
import { useRealtimeSubscription } from "../realtime/browser-realtime";

export type WorkspaceActivitySnapshot = {
  workspaceId: string;
  agents: { id: string; activity: ActivityEntry[] }[];
};

export type WorkspaceActivityView = {
  activity: Record<string, ActivityEntry[]>;
  loading: boolean;
  error: boolean;
};
const empty: WorkspaceActivityView = {
  activity: {},
  loading: true,
  error: false,
};
const emptyActivity: ActivityEntry[] = [];

export function activityForAgent(view: WorkspaceActivityView, agentId: string) {
  const activity = view.activity[agentId] ?? emptyActivity;
  return {
    activity,
    loading: activity.length === 0 && view.loading,
    error: activity.length === 0 && view.error,
  };
}

/**
 * One Workspace Activity subscription for the whole app shell. It shares the
 * `_app` browser connection and keeps only the newest observations per Agent;
 * avatars and detail pages read this view instead of subscribing themselves.
 */
export function useWorkspaceActivity({
  workspaceId,
  refresh,
  getConnectionToken,
}: {
  workspaceId?: string;
  refresh: () => Promise<WorkspaceActivitySnapshot>;
  getConnectionToken: () => Promise<string>;
}): WorkspaceActivityView {
  const [view, setView] = useState({ workspaceId, ...empty });
  const refreshHistory = useRef<(afterConnection?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    setView({ workspaceId, ...empty });
    if (!workspaceId) return;
    let disposed = false;
    let refreshing = false;
    let refreshQueued = false;
    const load = async (afterConnection = false) => {
      if (disposed) return;
      if (refreshing) {
        refreshQueued ||= afterConnection;
        return;
      }
      refreshing = true;
      try {
        const snapshot = await refresh();
        if (disposed) return;
        if (snapshot.workspaceId !== workspaceId) throw new Error("Workspace changed");
        setView((current) => ({
          workspaceId,
          loading: false,
          error: false,
          activity: {
            ...(current.workspaceId === workspaceId ? current.activity : {}),
            ...Object.fromEntries(
              snapshot.agents.map((agent) => [
                agent.id,
                mergeAgentActivity(
                  current.workspaceId === workspaceId ? (current.activity[agent.id] ?? []) : [],
                  agent.activity,
                ).slice(0, 5),
              ]),
            ),
          },
        }));
      } catch {
        if (!disposed) setView((current) => ({ ...current, loading: false, error: true }));
      } finally {
        refreshing = false;
        if (refreshQueued) {
          refreshQueued = false;
          void load();
        }
      }
    };
    refreshHistory.current = load;
    void load();
    return () => {
      disposed = true;
    };
  }, [workspaceId, refresh]);

  useRealtimeSubscription({
    channel: workspaceId ? agentActivityChannel(workspaceId) : undefined,
    getToken: getConnectionToken,
    onSubscribed: () => void refreshHistory.current(true),
    onPublication: (publication) => {
      if (!workspaceId) return;
      const observation = decodeActivityObservation(publication.data, { workspaceId });
      if (!observation) return;
      setView((current) =>
        current.workspaceId === workspaceId
          ? {
              ...current,
              activity: {
                ...current.activity,
                [observation.agentId]: mergeAgentActivity(
                  current.activity[observation.agentId] ?? [],
                  [observation.entry],
                ).slice(0, 5),
              },
            }
          : current,
      );
    },
  });

  return view.workspaceId === workspaceId ? view : empty;
}
