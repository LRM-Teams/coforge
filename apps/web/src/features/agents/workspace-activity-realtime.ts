import { useEffect, useState } from "react";
import { Centrifuge } from "centrifuge/build/protobuf";
import { decodeAgentActivity, WORKSPACE_PROTOCOL_MAJOR } from "@coforge/protocol";
import { mergeAgentActivity, type ActivityEntry } from "./agent-activity";

export type WorkspaceActivitySnapshot = {
  workspaceId: string;
  agents: { id: string; activity: ActivityEntry[] }[];
};
export type WorkspaceActivityView = {
  activity: Record<string, ActivityEntry[]>;
  loading: boolean;
  error: boolean;
};
const empty: WorkspaceActivityView = { activity: {}, loading: true, error: false };
const emptyActivity: ActivityEntry[] = [];

export function activityForAgent(view: WorkspaceActivityView, agentId: string) {
  const activity = view.activity[agentId] ?? emptyActivity;
  return {
    activity,
    loading: activity.length === 0 && view.loading,
    error: activity.length === 0 && view.error,
  };
}

/** One subscription per messages host; never mounted by individual avatars. */
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
  useEffect(() => {
    setView({ workspaceId, ...empty });
    if (!workspaceId) return;
    let disposed = false;
    let refreshing = false;
    let refreshQueued = false;
    const channel = `activity:${workspaceId}`;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new Centrifuge(`${protocol}//${location.host}/connection/websocket`, {
      getToken: getConnectionToken,
    });
    const refreshHistory = async (afterConnection = false) => {
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
          void refreshHistory();
        }
      }
    };
    client.on("connected", () => {
      void refreshHistory(true);
    });
    client.on("publication", (publication) => {
      if (publication.channel !== channel || !(publication.data instanceof Uint8Array)) return;
      try {
        const event = decodeAgentActivity(publication.data);
        if (
          event.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR ||
          event.workspaceId !== workspaceId ||
          !event.agentId ||
          !event.launchId ||
          !Number.isSafeInteger(event.clientSeq) ||
          event.clientSeq < 1
        )
          return;
        const occurredAt = new Date(event.occurredAt);
        if (!Number.isFinite(occurredAt.getTime()) || disposed) return;
        const entry: ActivityEntry = {
          launchId: event.launchId,
          clientSeq: event.clientSeq,
          activity: event.activity,
          level: event.level,
          message: "",
          occurredAt,
        };
        setView((current) => ({
          ...current,
          workspaceId,
          activity: {
            ...current.activity,
            [event.agentId]: mergeAgentActivity(current.activity[event.agentId] ?? [], [
              entry,
            ]).slice(0, 5),
          },
        }));
      } catch {
        /* Ignore malformed best-effort observations. */
      }
    });
    client.connect();
    void refreshHistory();
    return () => {
      disposed = true;
      client.disconnect();
    };
  }, [workspaceId, refresh, getConnectionToken]);
  return view.workspaceId === workspaceId ? view : empty;
}
