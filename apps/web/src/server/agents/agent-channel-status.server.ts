import type { AgentDisplay } from "./agent-display.server";

export type AgentChannelStatus = {
  status: "online" | "offline" | "unknown";
  activity?: string;
  activityDetail?: string;
};

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
  scope: { workspaceId: string; computerId: string | null; agentId: string },
): Promise<AgentChannelStatus> {
  if (!scope.computerId) return { status: "unknown" };
  try {
    const snapshot = await display.snapshot({
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
      agentId: scope.agentId,
    });
    if (snapshot.activityKind === "offline") return { status: "offline" };
    if (snapshot.activityKind === "online") return { status: "online" };
    return {
      status: "online",
      activity: snapshot.activityKind,
      ...(snapshot.detail ? { activityDetail: snapshot.detail } : {}),
    };
  } catch {
    return { status: "unknown" };
  }
}
