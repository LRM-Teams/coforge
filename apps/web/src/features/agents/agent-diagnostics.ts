import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

/**
 * The plain-text block the Activity tab's copy button puts on the clipboard, for pasting into a
 * support thread. Keys are CoForge's own field names, in English (they are read by people and by
 * grep, not shown as UI); a fact the panel doesn't have reads `unknown`, and an Agent on its
 * provider's default model reads `default`.
 */
export type AgentDiagnosticFacts = {
  id: string;
  workspaceId: string;
  computerId: string | null;
  computerVersion: string | null;
  runtime: string;
  model: string;
  /** The user stopped it: an intent, reported beside the status rather than in place of it. */
  stopped: boolean;
  status: string;
};

export function agentDiagnosticInfo({
  agent,
  display,
  lastActivityAtMs,
  reportedAt = new Date(),
}: {
  agent: AgentDiagnosticFacts;
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
    `status: ${agent.status}`,
    `stopped: ${agent.stopped}`,
    `activityKind: ${display?.activityKind ?? "unknown"}`,
    `detailKind: ${display?.detailKind ?? "unknown"}`,
    `lastActivityAtUtc: ${
      lastActivityAtMs === undefined ? "unknown" : new Date(lastActivityAtMs).toISOString()
    }`,
  ].join("\n");
}
