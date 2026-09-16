import type { ActivityTrajectoryEntry } from "@lrm/coforge-sdk/internal";
import type { AgentActivityKind } from "@lrm/coforge-sdk/internal";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  decodeAgentActivity,
  WORKSPACE_PROTOCOL_MAJOR,
} from "@lrm/coforge-sdk/internal";

export type ActivityEntry = {
  id?: string;
  launchId: string;
  clientSeq: number;
  activityKind?: AgentActivityKind;
  detailKind: string;
  level: string;
  detail: string;
  observedAtMs: number;
  entries?: ActivityTrajectoryEntry[];
  runtimeError?: { errorClass: string; errorReason: string; fingerprint: string };
  createdAt?: Date;
};

export const agentActivityChannel = (workspaceId: string) => `agent:activity:${workspaceId}`;

export type AgentActivityObservation = { agentId: string; entry: ActivityEntry };

/**
 * Decodes one Activity publication within a Workspace (and optionally one
 * Agent) scope. Malformed or out-of-scope observations return undefined.
 */
export function decodeActivityObservation(
  data: unknown,
  scope: { workspaceId: string; agentId?: string },
): AgentActivityObservation | undefined {
  if (!(data instanceof Uint8Array)) return undefined;
  try {
    const event = decodeAgentActivity(data);
    if (
      event.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR ||
      event.workspaceId !== scope.workspaceId ||
      !event.agentId ||
      (scope.agentId !== undefined && event.agentId !== scope.agentId) ||
      !event.launchId ||
      !Number.isSafeInteger(event.clientSeq) ||
      event.clientSeq < 1 ||
      !Number.isSafeInteger(event.observedAtMs) ||
      event.observedAtMs < 1 ||
      // A busy heartbeat only renews the display lease; a runtime_progress frame
      // carries no rendered content. Neither belongs in the recent-activity list.
      event.isHeartbeat === true ||
      event.detailKind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS
    )
      return undefined;
    return {
      agentId: event.agentId,
      entry: {
        launchId: event.launchId,
        clientSeq: event.clientSeq,
        activityKind: event.activityKind,
        detailKind: event.detailKind,
        level: event.level,
        detail: event.detail,
        observedAtMs: event.observedAtMs,
        entries: event.entries,
        runtimeError: event.runtimeError,
      },
    };
  } catch {
    return undefined;
  }
}

export function mergeAgentActivity(current: ActivityEntry[], incoming: ActivityEntry[]) {
  const entries = new Map<string, ActivityEntry>();
  for (const entry of [...current, ...incoming]) {
    // Defense in depth: a content-free runtime_progress frame should already
    // have been dropped by decodeActivityObservation before reaching here.
    if (entry.detailKind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS) continue;
    const key = `${entry.launchId}:${entry.clientSeq}`;
    // Live observations have no database ID; never downgrade a persisted copy.
    if (entries.get(key)?.id && !entry.id) continue;
    entries.set(key, entry);
  }
  return orderActivity([...entries.values()]).slice(0, 100);
}

function orderActivity<T extends ActivityEntry>(activity: T[]): T[] {
  const chronological = [...activity].sort(
    (a, b) =>
      b.observedAtMs - a.observedAtMs ||
      (b.createdAt?.getTime() ?? b.observedAtMs) - (a.createdAt?.getTime() ?? a.observedAtMs),
  );
  // Cross-launch order is observational. Within each launch, sequence is stronger
  // than wall time. Reorder its existing slots rather than using a non-transitive comparator.
  const launches = new Map<string, T[]>();
  for (const entry of chronological) {
    const entries = launches.get(entry.launchId) ?? [];
    entries.push(entry);
    launches.set(entry.launchId, entries);
  }
  for (const entries of launches.values()) entries.sort((a, b) => a.clientSeq - b.clientSeq);
  return chronological.map((entry) => launches.get(entry.launchId)!.pop()!);
}

const recoveredKinds: readonly string[] = [
  AGENT_ACTIVITY_DETAIL_KIND.STARTING,
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.IDLE,
];

export function latestActivityError<T extends ActivityEntry>(activity: T[]) {
  // Newest-first. A successful launch/resumed work supersedes older failures;
  // shutdown, warnings and unknown events do not prove recovery.
  const ordered = orderActivity(activity);
  const outcome = ordered.find(
    (entry) => entry.level === "error" || recoveredKinds.includes(entry.detailKind),
  );
  if (outcome?.level !== "error") return undefined;
  const recovered = ordered.some(
    (entry) =>
      entry.level !== "error" &&
      recoveredKinds.includes(entry.detailKind) &&
      entry.observedAtMs >= outcome.observedAtMs,
  );
  return recovered ? undefined : outcome;
}
