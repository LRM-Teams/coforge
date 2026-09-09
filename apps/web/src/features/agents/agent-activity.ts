import type { ActivityTrajectoryEntry } from "@coforge/protocol";
import type { AgentActivityKind } from "@coforge/protocol/agent-display";

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

export function mergeAgentActivity(current: ActivityEntry[], incoming: ActivityEntry[]) {
  const entries = new Map<string, ActivityEntry>();
  for (const entry of [...current, ...incoming]) {
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

export function latestActivityError<T extends ActivityEntry>(activity: T[]) {
  // Newest-first. A successful launch/resumed work supersedes older failures;
  // shutdown, warnings and unknown events do not prove recovery.
  const ordered = orderActivity(activity);
  const outcome = ordered.find(
    (entry) =>
      entry.level === "error" ||
      ["starting", "model_response_started", "thinking_started", "idle"].includes(entry.detailKind),
  );
  if (outcome?.level !== "error") return undefined;
  const recovered = ordered.some(
    (entry) =>
      entry.level !== "error" &&
      ["starting", "model_response_started", "thinking_started", "idle"].includes(
        entry.detailKind,
      ) &&
      entry.observedAtMs >= outcome.observedAtMs,
  );
  return recovered ? undefined : outcome;
}
