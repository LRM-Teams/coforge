import { useEffect, useState } from "react";
import { Centrifuge } from "centrifuge";

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
  status: AgentStatusView;
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
  return { agentId, status, expiresAt, daemonInstanceId, clientSeq, observedAtMs };
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

export function mergeAgentStatusSnapshot<T extends StatusTrackedAgent>(
  current: T[],
  snapshot: T[],
) {
  return snapshot.map((agent) => {
    const existing = current.find((value) => value.id === agent.id);
    if (!existing) return agent;
    const ordering = agent.status.ordering;
    if (!ordering) return { ...agent, status: existing.status };
    return applyAgentStatusEvent([{ ...agent, status: existing.status }], {
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
      ? { ...agent, status: { ...agent.status, value: "inactive" as const, expiresAt: null } }
      : agent,
  );
}

export function useAgentStatuses<T extends StatusTrackedAgent>({
  agents,
  workspaceId,
  refresh,
  getConnectionToken,
}: {
  agents: T[];
  workspaceId?: string;
  refresh: () => Promise<T[]>;
  getConnectionToken: () => Promise<string>;
}) {
  const [visibleAgents, setVisibleAgents] = useState(() => expireAgentStatuses(agents, Date.now()));

  useEffect(
    () =>
      setVisibleAgents((current) =>
        expireAgentStatuses(mergeAgentStatusSnapshot(current, agents), Date.now()),
      ),
    [agents],
  );

  useEffect(() => {
    const expiresAt = Math.min(
      ...visibleAgents.flatMap((agent) =>
        agent.status.value === "active" && agent.status.expiresAt ? [agent.status.expiresAt] : [],
      ),
    );
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(
      () =>
        setVisibleAgents((current) =>
          current.map((agent) =>
            agent.status.value === "active" &&
            typeof agent.status.expiresAt === "number" &&
            agent.status.expiresAt <= Date.now()
              ? { ...agent, status: { ...agent.status, value: "inactive", expiresAt: null } }
              : agent,
          ),
        ),
      Math.max(0, expiresAt - Date.now()) + 10,
    );
    return () => window.clearTimeout(timer);
  }, [visibleAgents]);

  useEffect(() => {
    if (!workspaceId) return;
    const channel = agentStatusChannel(workspaceId);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new Centrifuge(`${protocol}//${location.host}/connection/websocket`, {
      getToken: getConnectionToken,
    });
    let disposed = false;
    const refreshSnapshot = async () => {
      const refreshed = await refresh();
      if (!disposed)
        setVisibleAgents((current) =>
          expireAgentStatuses(mergeAgentStatusSnapshot(current, refreshed), Date.now()),
        );
    };
    client.on("connected", () => {
      void refreshSnapshot().catch(() => {});
    });
    client.on("publication", (publication) => {
      if (publication.channel !== channel) return;
      try {
        const event = decodeAgentStatusEvent(publication.data);
        setVisibleAgents((current) => applyAgentStatusEvent(current, event));
      } catch {}
    });
    client.connect();
    return () => {
      disposed = true;
      client.disconnect();
    };
  }, [getConnectionToken, refresh, workspaceId]);

  return visibleAgents;
}
