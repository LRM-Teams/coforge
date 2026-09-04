export type AgentStatusEvent = {
  agentId: string;
  status: "active" | "inactive";
  expiresAt: number | null;
};

type StatusTrackedAgent = {
  id: string;
  status: "active" | "inactive";
  statusExpiresAt?: number | null;
};
type UpdatedAgent<T extends StatusTrackedAgent> = Omit<T, "status" | "statusExpiresAt"> & {
  status: "active" | "inactive";
  statusExpiresAt: number | null;
};

export const agentStatusChannel = (workspaceId: string) => `status:${workspaceId}`;

export function createAgentStatusConnectedHandler<T>(
  refresh: () => Promise<T[]>,
  apply: (agents: T[]) => void,
) {
  return async () => apply(await refresh());
}

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
  if (
    typeof agentId !== "string" ||
    (status !== "active" && status !== "inactive") ||
    (expiresAt !== null && typeof expiresAt !== "number") ||
    (status === "active" && expiresAt === null) ||
    (status === "inactive" && expiresAt !== null)
  )
    throw new Error("invalid Agent status event");
  return { agentId, status, expiresAt };
}

export function applyAgentStatusEvent<T extends StatusTrackedAgent>(
  agents: T[],
  event: AgentStatusEvent,
): UpdatedAgent<T>[] {
  return agents.map((agent) =>
    agent.id === event.agentId
      ? { ...agent, status: event.status, statusExpiresAt: event.expiresAt }
      : { ...agent, status: agent.status, statusExpiresAt: agent.statusExpiresAt ?? null },
  );
}

export function expireAgentStatuses<T extends StatusTrackedAgent>(
  agents: T[],
  now: number,
): UpdatedAgent<T>[] {
  return agents.map((agent) =>
    agent.status === "active" &&
    typeof agent.statusExpiresAt === "number" &&
    agent.statusExpiresAt <= now
      ? { ...agent, status: "inactive" as const, statusExpiresAt: null }
      : { ...agent, statusExpiresAt: agent.statusExpiresAt ?? null },
  );
}
