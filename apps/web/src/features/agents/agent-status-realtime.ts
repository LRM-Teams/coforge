import { useEffect, useRef, useState } from "react";
import {
  parseAgentDisplaySnapshot,
  type AgentDisplaySnapshot,
} from "@coforge/protocol/agent-display";

import { useBrowserRealtime } from "../realtime/browser-realtime";

export type AgentStatusEvent = {
  agentId: string;
  status: "active" | "inactive";
  expiresAt: number | null;
  daemonInstanceId: string;
  clientSeq: number;
  observedAtMs: number;
};

type StatusTrackedAgent = {
  id: string;
  status: AgentStatusView | UnknownAgentStatusView;
  computerId?: string | null;
  workspaceId?: string;
  display?: AgentDisplaySnapshot;
  displayRevisionHighWater?: number;
};
export type AgentStatusView = {
  value: "active" | "inactive";
  expiresAt: number | null;
  ordering?: {
    daemonInstanceId: string;
    clientSeq: number;
    observedAtMs: number;
  } | null;
};
type UnknownAgentStatusView = Omit<AgentStatusView, "value"> & {
  value: "unknown";
};

export const agentStatusChannel = (workspaceId: string) => `status:${workspaceId}`;

export function encodeAgentStatusEvent(event: AgentStatusEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

export function decodeAgentStatusEvent(data: unknown): AgentStatusEvent {
  const value =
    data instanceof Uint8Array ? (JSON.parse(new TextDecoder().decode(data)) as unknown) : data;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Agent status event");
  const agentId = Reflect.get(value, "agentId");
  const status = Reflect.get(value, "status");
  const expiresAt = Reflect.get(value, "expiresAt");
  const daemonInstanceId = Reflect.get(value, "daemonInstanceId");
  const clientSeq = Reflect.get(value, "clientSeq");
  const observedAtMs = Reflect.get(value, "observedAtMs");
  if (
    typeof agentId !== "string" ||
    (status !== "active" && status !== "inactive") ||
    (expiresAt !== null && typeof expiresAt !== "number") ||
    (status === "active" && expiresAt === null) ||
    (status === "inactive" && expiresAt !== null) ||
    typeof daemonInstanceId !== "string" ||
    !daemonInstanceId ||
    !Number.isSafeInteger(clientSeq) ||
    clientSeq < 1 ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < 1
  )
    throw new Error("invalid Agent status event");
  return {
    agentId,
    status,
    expiresAt,
    daemonInstanceId,
    clientSeq,
    observedAtMs,
  };
}

function eventIsNewer(agent: StatusTrackedAgent, event: AgentStatusEvent) {
  const ordering = agent.status.ordering;
  if (!ordering) return true;
  if (ordering.daemonInstanceId === event.daemonInstanceId) {
    if (event.clientSeq !== ordering.clientSeq) return event.clientSeq > ordering.clientSeq;
    return (
      event.observedAtMs === ordering.observedAtMs &&
      (event.status === agent.status.value ||
        (event.status === "active" && agent.status.value === "inactive"))
    );
  }
  return event.observedAtMs > ordering.observedAtMs;
}

export function applyAgentStatusEvent<T extends StatusTrackedAgent>(
  agents: T[],
  event: AgentStatusEvent,
): T[] {
  return agents.map((agent) =>
    agent.id === event.agentId && eventIsNewer(agent, event)
      ? {
          ...agent,
          status: {
            value: event.status,
            expiresAt:
              event.status === "active" && agent.status.value === "active"
                ? Math.max(agent.status.expiresAt ?? 0, event.expiresAt ?? 0)
                : event.expiresAt,
            ordering: {
              daemonInstanceId: event.daemonInstanceId,
              clientSeq: event.clientSeq,
              observedAtMs: event.observedAtMs,
            },
          },
        }
      : agent,
  );
}

export function applyAgentDisplaySnapshot<T extends StatusTrackedAgent>(
  agents: T[],
  snapshot: AgentDisplaySnapshot,
  workspaceId?: string,
): T[] {
  if (workspaceId && snapshot.workspaceId !== workspaceId) return agents;
  return agents.map((agent) => {
    if (
      agent.id !== snapshot.agentId ||
      (agent.workspaceId && agent.workspaceId !== snapshot.workspaceId) ||
      (agent.computerId && agent.computerId !== snapshot.computerId)
    )
      return agent;
    const highWater = Math.max(agent.displayRevisionHighWater ?? 0, agent.display?.revision ?? 0);
    if (snapshot.revision < highWater || (!agent.display && snapshot.revision === highWater))
      return agent;
    if (agent.display?.revision === snapshot.revision) return agent;
    return { ...agent, display: snapshot, displayRevisionHighWater: snapshot.revision };
  });
}

export function mergeAgentStatusSnapshot<T extends StatusTrackedAgent>(
  current: T[],
  snapshot: T[],
) {
  return snapshot.map((agent) => {
    const existing = current.find((value) => value.id === agent.id);
    if (!existing) return agent;
    const displaySnapshot = agent.display ?? existing.display;
    const withDisplay = displaySnapshot
      ? applyAgentDisplaySnapshot(
          [
            {
              ...agent,
              display: existing.display,
              displayRevisionHighWater: existing.displayRevisionHighWater,
            },
          ],
          displaySnapshot,
          agent.workspaceId,
        )[0]!
      : { ...agent, displayRevisionHighWater: existing.displayRevisionHighWater };
    const ordering = agent.status.ordering;
    if (!ordering) return { ...withDisplay, status: existing.status };
    if (agent.status.value === "unknown") return { ...withDisplay, status: existing.status };
    return applyAgentStatusEvent([{ ...withDisplay, status: existing.status }], {
      agentId: agent.id,
      status: agent.status.value,
      expiresAt: agent.status.expiresAt,
      ...ordering,
    })[0]!;
  });
}

export function expireAgentStatuses<T extends StatusTrackedAgent>(agents: T[], now: number): T[] {
  return agents.map((agent) =>
    agent.status.value === "active" &&
    typeof agent.status.expiresAt === "number" &&
    agent.status.expiresAt <= now
      ? {
          ...agent,
          status: {
            ...agent.status,
            value: "inactive" as const,
            expiresAt: null,
          },
        }
      : agent,
  );
}

export function useAgentStatuses<T extends StatusTrackedAgent>({
  agents,
  workspaceId,
  refresh,
}: {
  agents: T[];
  workspaceId?: string;
  refresh: () => Promise<T[]>;
}) {
  const client = useBrowserRealtime();
  const [visibleAgents, setVisibleAgents] = useState(() => expireAgentStatuses(agents, Date.now()));
  const mounted = useRef(true);
  const currentWorkspaceId = useRef(workspaceId);
  const visibleWorkspaceId = useRef(workspaceId);
  currentWorkspaceId.current = workspaceId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (visibleWorkspaceId.current !== workspaceId) {
      visibleWorkspaceId.current = workspaceId;
      setVisibleAgents(expireAgentStatuses(agents, Date.now()));
      return;
    }
    setVisibleAgents((current) =>
      expireAgentStatuses(mergeAgentStatusSnapshot(current, agents), Date.now()),
    );
  }, [agents, workspaceId]);

  useEffect(() => {
    const statusExpiresAt = Math.min(
      ...visibleAgents.flatMap((agent) =>
        agent.status.value === "active" && agent.status.expiresAt ? [agent.status.expiresAt] : [],
      ),
    );
    if (!Number.isFinite(statusExpiresAt)) return;
    const timer = window.setTimeout(
      () =>
        setVisibleAgents((current) =>
          current.map((agent) =>
            agent.status.value === "active" &&
            typeof agent.status.expiresAt === "number" &&
            agent.status.expiresAt <= Date.now()
              ? {
                  ...agent,
                  status: {
                    ...agent.status,
                    value: "inactive",
                    expiresAt: null,
                  },
                }
              : agent,
          ),
        ),
      Math.max(0, statusExpiresAt - Date.now()) + 10,
    );
    return () => window.clearTimeout(timer);
  }, [visibleAgents]);

  useEffect(() => {
    const expiresAt = Math.min(
      ...visibleAgents.flatMap((agent) =>
        typeof agent.display?.expiresAt === "number" ? [agent.display.expiresAt] : [],
      ),
    );
    if (!Number.isFinite(expiresAt)) return;
    const refreshWorkspaceId = workspaceId;
    let disposed = false;
    let timer: number;
    const requestRefresh = (delay: number) => {
      timer = window.setTimeout(runRefresh, delay);
    };
    const runRefresh = () => {
      void refresh()
        .then((refreshed) => {
          if (disposed || !mounted.current || currentWorkspaceId.current !== refreshWorkspaceId)
            return;
          setVisibleAgents((current) => mergeAgentStatusSnapshot(current, refreshed));
        })
        .catch(() => {
          if (!disposed && mounted.current && currentWorkspaceId.current === refreshWorkspaceId)
            requestRefresh(1_000);
        });
    };
    requestRefresh(expiresAt <= Date.now() ? 1_000 : expiresAt - Date.now() + 10);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refresh, visibleAgents, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !client) return;
    const channel = agentStatusChannel(workspaceId);
    let disposed = false;
    const refreshSnapshot = async () => {
      const refreshed = await refresh();
      if (!disposed)
        setVisibleAgents((current) =>
          expireAgentStatuses(mergeAgentStatusSnapshot(current, refreshed), Date.now()),
        );
    };
    const onConnected = () => {
      void refreshSnapshot().catch(() => {});
    };
    const onPublication = (publication: { channel: string; data: unknown }) => {
      if (publication.channel !== channel) return;
      try {
        const value =
          publication.data instanceof Uint8Array
            ? (JSON.parse(new TextDecoder().decode(publication.data)) as unknown)
            : publication.data;
        if (Reflect.get(value as object, "type") === "agent:display") {
          const snapshot = parseAgentDisplaySnapshot(value);
          setVisibleAgents((current) => applyAgentDisplaySnapshot(current, snapshot, workspaceId));
        } else {
          const event = decodeAgentStatusEvent(value);
          setVisibleAgents((current) => applyAgentStatusEvent(current, event));
        }
      } catch {}
    };
    client.on("connected", onConnected);
    client.on("publication", onPublication);
    return () => {
      disposed = true;
      client.off("connected", onConnected);
      client.off("publication", onPublication);
    };
  }, [client, refresh, workspaceId]);

  return visibleAgents;
}
