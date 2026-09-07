export type ActivityEntry = {
  id?: string;
  launchId: string;
  clientSeq: number;
  activity: string;
  level: string;
  message: string;
  occurredAt: Date;
  createdAt?: Date;
  diagnosticErrorClass?: string | null;
  diagnosticReason?: string | null;
  diagnosticFingerprint?: string | null;
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
      b.occurredAt.getTime() - a.occurredAt.getTime() ||
      (b.createdAt ?? b.occurredAt).getTime() - (a.createdAt ?? a.occurredAt).getTime(),
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
  const outcome = orderActivity(activity).find(
    (entry) =>
      entry.level === "error" ||
      ["starting", "working", "turn_completed", "idle"].includes(entry.activity),
  );
  return outcome?.level === "error" ? outcome : undefined;
}
