import { useEffect, useRef, useState } from "react";
import { parseAgentDisplaySnapshot, type AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { useRealtimeSubscription, useRealtimeSubscriptions } from "../realtime/browser-realtime";

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

export const agentStatusChannel = (workspaceId: string) => `agent:status:${workspaceId}`;

/** The re-routed destination for a private Agent's `agent:display` snapshot (ADR 0059), the
 * status-channel sibling of `agentActivityChannelForAgent`: only a viewer who can currently see
 * that Agent is ever issued a subscription token for it. */
export const agentStatusChannelForAgent = (workspaceId: string, agentId: string) =>
  `agent:status:${workspaceId}:${agentId}`;

/**
 * ADR 0059: the id-only event a visibility change publishes on the shared status channel. A
 * browser that receives it refetches its Agent list, drops the Agent from caches if it can no
 * longer see it, or (re)subscribes to its per-Agent channels if it still can.
 */
export type AgentVisibilityChangedEvent = { type: "agent:visibility_changed"; agentId: string };

export function isAgentVisibilityChangedEvent(
  value: unknown,
): value is AgentVisibilityChangedEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.get(value as object, "type") === "agent:visibility_changed" &&
    typeof Reflect.get(value as object, "agentId") === "string"
  );
}

// Must match ACTIVITY_PROBE_TIMEOUT_MS in
// `server/agents/agent-activity-sweep.server.ts`. Duplicated here rather than
// imported because browser code cannot import a `.server.ts` module.
export const ACTIVITY_PROBE_TIMEOUT_MS = 5_000;

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

/**
 * The delay before `useAgentStatuses` next re-fetches the display snapshot,
 * given the current agents' display expiry deadlines. A `working`/`thinking`
 * display does not schedule its refresh at its own `expiresAt`: that
 * deadline is pushed out by `ACTIVITY_PROBE_TIMEOUT_MS + 1_000`, so the
 * refresh is purely a safety net behind the server sweep's own
 * `agent:display` push once its own probe times out (see ADR 0020). Every
 * other display kind keeps refreshing right at its own `expiresAt`. Returns
 * `undefined` when there is nothing to schedule.
 */
export function nextDisplayRefreshDelayMs<T extends StatusTrackedAgent>(
  agents: readonly T[],
  now: number,
): number | undefined {
  const deadline = Math.min(
    ...agents.flatMap((agent) => {
      const display = agent.display;
      if (!display || typeof display.expiresAt !== "number") return [];
      const isBusy = display.activityKind === "working" || display.activityKind === "thinking";
      return [isBusy ? display.expiresAt + ACTIVITY_PROBE_TIMEOUT_MS + 1_000 : display.expiresAt];
    }),
  );
  if (!Number.isFinite(deadline)) return undefined;
  return deadline <= now ? 1_000 : deadline - now + 10;
}

export function useAgentStatuses<T extends StatusTrackedAgent>({
  agents,
  workspaceId,
  refresh,
  getConnectionToken,
  privateAgentIds = [],
  getPrivateAgentStatusToken,
}: {
  agents: T[];
  workspaceId?: string;
  refresh: () => Promise<T[]>;
  getConnectionToken: () => Promise<string>;
  /** ADR 0059: ids of the viewer's own visible private Agents. Their `agent:display` snapshots
   * no longer arrive on the shared status channel, so each needs its own per-Agent subscription
   * on the same shared Centrifuge client. */
  privateAgentIds?: readonly string[];
  getPrivateAgentStatusToken?: (agentId: string) => Promise<string>;
}) {
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
      () => setVisibleAgents((current) => expireAgentStatuses(current, Date.now())),
      Math.max(0, statusExpiresAt - Date.now()) + 10,
    );
    return () => window.clearTimeout(timer);
  }, [visibleAgents]);

  useEffect(() => {
    const initialDelay = nextDisplayRefreshDelayMs(visibleAgents, Date.now());
    if (initialDelay === undefined) return;
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
    requestRefresh(initialDelay);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refresh, visibleAgents, workspaceId]);

  const refreshSnapshot = async () => {
    const refreshed = await refresh();
    if (mounted.current)
      setVisibleAgents((current) =>
        expireAgentStatuses(mergeAgentStatusSnapshot(current, refreshed), Date.now()),
      );
  };

  const handleStatusPublication = (data: unknown) => {
    try {
      const value =
        data instanceof Uint8Array ? (JSON.parse(new TextDecoder().decode(data)) as unknown) : data;
      if (isAgentVisibilityChangedEvent(value)) {
        // ADR 0059: refetch immediately rather than waiting for the next scheduled refresh —
        // `mergeAgentStatusSnapshot` already drops any Agent absent from the fresh list, and
        // subscribing/unsubscribing its per-Agent channels follows from that same fresh list
        // wherever it is consumed (see `WorkspaceAgentsProvider`).
        void refreshSnapshot().catch(() => {});
      } else if (Reflect.get(value as object, "type") === "agent:display") {
        const snapshot = parseAgentDisplaySnapshot(value);
        setVisibleAgents((current) => applyAgentDisplaySnapshot(current, snapshot, workspaceId));
      } else {
        const event = decodeAgentStatusEvent(value);
        setVisibleAgents((current) => applyAgentStatusEvent(current, event));
      }
    } catch {}
  };

  useRealtimeSubscription({
    channel: workspaceId ? agentStatusChannel(workspaceId) : undefined,
    getToken: getConnectionToken,
    onConnected: () => void refreshSnapshot().catch(() => {}),
    onPublication: (publication) => handleStatusPublication(publication.data),
  });

  // ADR 0059: one status subscription per visible private Agent, on the same shared client.
  useRealtimeSubscriptions({
    channels:
      workspaceId && getPrivateAgentStatusToken
        ? privateAgentIds.map((agentId) => ({
            channel: agentStatusChannelForAgent(workspaceId, agentId),
            getToken: () => getPrivateAgentStatusToken(agentId),
          }))
        : [],
    onPublication: (_channel, publication) => handleStatusPublication(publication.data),
  });

  return visibleAgents;
}
