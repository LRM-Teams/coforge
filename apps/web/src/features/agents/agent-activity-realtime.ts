import { useEffect, useState } from "react";
import { Centrifuge } from "centrifuge/build/protobuf";
import { decodeAgentActivity, WORKSPACE_PROTOCOL_MAJOR } from "@coforge/protocol";
import { mergeAgentActivity, type ActivityEntry } from "./agent-activity";

export const agentActivityChannel = (workspaceId: string) => `activity:${workspaceId}`;

export function useAgentActivity({
  agentId,
  workspaceId,
  activity,
  refresh,
  getConnectionToken,
}: {
  agentId: string;
  workspaceId: string;
  activity: ActivityEntry[];
  refresh: () => Promise<ActivityEntry[]>;
  getConnectionToken: () => Promise<string>;
}) {
  const [visible, setVisible] = useState({ agentId, activity });
  useEffect(() => {
    setVisible((current) => ({
      agentId,
      activity: mergeAgentActivity(current.agentId === agentId ? current.activity : [], activity),
    }));
  }, [agentId, activity]);

  useEffect(() => {
    const channel = `activity:${workspaceId}`;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new Centrifuge(`${protocol}//${location.host}/connection/websocket`, {
      getToken: getConnectionToken,
    });
    let disposed = false;
    const merge = (incoming: ActivityEntry[]) => {
      if (!disposed)
        setVisible((current) => ({
          agentId,
          activity: mergeAgentActivity(
            current.agentId === agentId ? current.activity : [],
            incoming,
          ),
        }));
    };
    client.on("connected", () => {
      // Rehydrate after subscribing, preserving publications arriving while history loads.
      void refresh()
        .then(merge)
        .catch(() => {});
    });
    client.on("publication", (publication) => {
      if (publication.channel !== channel || !(publication.data instanceof Uint8Array)) return;
      try {
        const event = decodeAgentActivity(publication.data);
        if (
          event.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR ||
          event.workspaceId !== workspaceId ||
          event.agentId !== agentId ||
          !event.launchId ||
          !Number.isSafeInteger(event.clientSeq) ||
          event.clientSeq < 1
        )
          return;
        if (!Number.isSafeInteger(event.observedAtMs) || event.observedAtMs < 1) return;
        merge([
          {
            launchId: event.launchId,
            clientSeq: event.clientSeq,
            detailKind: event.detailKind,
            level: event.level,
            detail: event.detail,
            observedAtMs: event.observedAtMs,
            entries: event.entries,
            runtimeError: event.runtimeError,
          },
        ]);
      } catch {
        // Malformed observations must not break the page or its independent status stream.
      }
    });
    client.connect();
    return () => {
      disposed = true;
      client.disconnect();
    };
  }, [agentId, workspaceId, refresh, getConnectionToken]);

  return visible.agentId === agentId ? visible.activity : activity;
}
