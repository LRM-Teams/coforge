import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

/**
 * The plain-text block the Activity tab's copy button puts on the clipboard, for pasting into a
 * support thread. Keys stay English and stable (they are read by people and by grep, not shown
 * as UI); a fact the panel doesn't have reads `unknown`.
 */
export function agentDiagnosticInfo({
  agent,
  display,
  lastActivityAtMs,
  reportedAt = new Date(),
}: {
  agent: {
    id: string;
    workspaceId: string;
    computerId: string | null;
    computerVersion: string | null;
    runtime: string;
    model: string;
    stopped: boolean;
    status: string;
  };
  display?: Pick<AgentDisplaySnapshot, "activityKind" | "detailKind" | "detail">;
  lastActivityAtMs: number | undefined;
  reportedAt?: Date;
}): string {
  const errorMessage = display?.activityKind === "error" ? display.detail.trim() : "";
  return [
    "CoForge Agent diagnostic info",
    ...(errorMessage ? [`errorMessage: ${errorMessage}`] : []),
    `reportedAtUtc: ${reportedAt.toISOString()}`,
    `workspaceId: ${agent.workspaceId}`,
    `agentId: ${agent.id}`,
    `computerId: ${agent.computerId ?? "unknown"}`,
    `runtime: ${agent.runtime}`,
    `model: ${agent.model || "default"}`,
    `computerVersion: ${agent.computerVersion ?? "unknown"}`,
    `agentStatus: ${agent.stopped ? "stopped" : agent.status}`,
    `activity: ${display?.activityKind ?? "unknown"}`,
    `activityKind: ${display?.detailKind ?? "unknown"}`,
    `lastActivityAtUtc: ${
      lastActivityAtMs === undefined ? "unknown" : new Date(lastActivityAtMs).toISOString()
    }`,
  ].join("\n");
}
