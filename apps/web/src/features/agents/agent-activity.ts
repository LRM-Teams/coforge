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
  /** Raft's freshness-decision lineage (`freshness_decision_fact:<sha256>`); set on a
   * freshness-hold row only. */
  producerFactId?: string;
  createdAt?: Date;
};

export const agentActivityChannel = (workspaceId: string) => `agent:activity:${workspaceId}`;

/** The avatar popover's row count. */
export const RECENT_ACTIVITY_LIMIT = 5;

/**
 * ADR 0021 (amended): `runtime_progress` is the one detail kind that stays a
 * content-free liveness filler — never persisted, never shown anywhere.
 * `tool_end`, `thinking_end` and `compaction_finished` are ordinary status
 * rows now (persisted to history, part of the live Activity timeline); they
 * are still excluded from the avatar's short recent-activity popover
 * (`agent-activity-avatar.tsx`) so that view stays limited to genuinely
 * noteworthy events instead of every tool/thinking completion. Kept local
 * (rather than imported from the server display module) because this file is
 * shared with the browser bundle.
 */
export const POPOVER_EXCLUDED_DETAIL_KINDS: ReadonlySet<string> = new Set([
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED,
]);

/**
 * `thinking_started`/`model_response_started` fire twice: once as a content-free marker the
 * instant a run begins (no `entries`, empty `detail` — its only job is flipping the display
 * status, which `agent-display.server.ts` already does from `detailKind`/`level` alone, entries
 * or not), and again with real `entries` once the daemon has actual thinking/output text to
 * flush. Only the marker is filtered out of history and the timeline; the real flush is an
 * ordinary Thinking/Output row and is untouched by this predicate.
 */
export function isRunStartMarker(detailKind: string, entries?: ActivityTrajectoryEntry[]) {
  return (
    (detailKind === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED ||
      detailKind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED) &&
    !(entries && entries.length > 0)
  );
}

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
      // A busy heartbeat only renews the display lease; a content-free
      // runtime_progress frame carries no rendered content (ADR 0021,
      // amended — tool_end/thinking_end/compaction_finished no longer belong
      // here, see POPOVER_EXCLUDED_DETAIL_KINDS); a run-start marker carries
      // no rendered content either (see isRunStartMarker); a reply to the
      // server's own liveness probe (ADR 0020) is a liveness fact, not new
      // content. None of these belong in the Activity timeline or the
      // recent-activity list.
      event.isHeartbeat === true ||
      event.detailKind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS ||
      isRunStartMarker(event.detailKind, event.entries) ||
      Boolean(event.probeId)
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
        producerFactId: event.producerFactId,
      },
    };
  } catch {
    return undefined;
  }
}

/** The client keeps up to this many activity frames per Agent (mirrors the server's history
 * cap in `AgentActivityRepository.list`). */
const ACTIVITY_WINDOW = 500;

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
  return orderActivity([...entries.values()]).slice(0, ACTIVITY_WINDOW);
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
