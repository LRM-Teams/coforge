import type { AgentDisplay } from "./agent-display.server";

export type AgentChannelStatus = {
  status: "online" | "offline" | "unknown";
  activity?: string;
  activityDetail?: string;
};

type Scope = { workspaceId: string; computerId: string | null; agentId: string };
type Snapshot = Awaited<ReturnType<AgentDisplay["snapshot"]>>;

/**
 * Best-effort live status for one Agent's `channel members` roster row, matching Raft's
 * `agentStatusLabel` inputs: a lifecycle (`online`/`offline`) and, when the Agent is doing
 * something more specific than merely being connected, an `activity` (`working`/`thinking`/
 * `error`) with its `activityDetail`. `unknown` only when the server truly has no data — the
 * Agent has never had a Computer, or the display snapshot itself could not be read (e.g. Redis
 * unavailable) — never as a placeholder for "didn't bother to check."
 */
export async function resolveAgentChannelStatus(
  display: Pick<AgentDisplay, "snapshot">,
  scope: Scope,
): Promise<AgentChannelStatus> {
  if (!scope.computerId) return { status: "unknown" };
  try {
    return statusFromSnapshot(
      await display.snapshot({
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        agentId: scope.agentId,
      }),
    );
  } catch {
    return { status: "unknown" };
  }
}

/**
 * A whole roster's statuses, in `scopes` order, from one batched display read. The batched read
 * is all-or-nothing, so a failure falls back to one read per Agent: a single Agent's unreadable
 * display must not blank out every other row's status. Only the failure path pays N reads.
 */
export async function resolveAgentChannelStatuses(
  display: Pick<AgentDisplay, "snapshot" | "snapshotMany">,
  scopes: readonly Scope[],
): Promise<AgentChannelStatus[]> {
  const bound = scopes.flatMap((scope) =>
    scope.computerId
      ? [{ workspaceId: scope.workspaceId, computerId: scope.computerId, agentId: scope.agentId }]
      : [],
  );
  if (bound.length === 0) return scopes.map(() => ({ status: "unknown" }));
  try {
    const snapshots = await display.snapshotMany(bound);
    const byAgentId = new Map<string, Snapshot | undefined>(
      bound.map((scope, index) => [scope.agentId, snapshots[index]]),
    );
    return scopes.map((scope) => {
      const snapshot = byAgentId.get(scope.agentId);
      return snapshot ? statusFromSnapshot(snapshot) : { status: "unknown" };
    });
  } catch {
    return Promise.all(scopes.map((scope) => resolveAgentChannelStatus(display, scope)));
  }
}

function statusFromSnapshot(snapshot: Snapshot): AgentChannelStatus {
  if (snapshot.activityKind === "offline") return { status: "offline" };
  if (snapshot.activityKind === "online") return { status: "online" };
  return {
    status: "online",
    activity: snapshot.activityKind,
    ...(snapshot.detail ? { activityDetail: snapshot.detail } : {}),
  };
}
