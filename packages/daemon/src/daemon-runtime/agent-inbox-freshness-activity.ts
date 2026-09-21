import type { ActivityTrajectoryEntry } from "@lrm/coforge-sdk/internal";

/**
 * Raft 1.0.32 `projectApmHeldFreshnessActivity` (bundle 812425).
 *
 * One held send narrates exactly two things in Raft: a **status entry** —
 * `{kind:"status", activity:"working", activityKind:"working", detail: <title>,
 * detailKind:"freshness_hold", producerFactId}` — and a **`slock_action` entry** carrying the same
 * title plus a three-line text (`target:`, the count line, the decision line(s)). CoForge has one
 * Activity frame for both (a display status with optional trajectory entries), so this projects the
 * pair onto it: `activityKind`/`detail`/`detailKind` are the status entry, `entries` is the action
 * entry as the one system row our trajectory model has. The producer fact id travels on the frame.
 *
 * The wording, the count-line split between `local_hold` and `syncing_hold`, and the decision lines
 * are Raft's own strings, copied verbatim.
 */

export type HeldFreshnessActivityInput = {
  action: "send" | "task_claim" | "task_update";
  decision: "local_hold" | "syncing_hold";
  target: string;
  /** Raft's `messageCount`: `pendingCount` for `local_hold`, `heldMessageCount` for
   * `syncing_hold` (see `recordFreshnessDecisionActivity`, bundle 843454). */
  messageCount: number;
  producerFactId: string;
};

export type HeldFreshnessActivity = {
  activityKind: "working";
  detailKind: "freshness_hold";
  detail: string;
  entries: ActivityTrajectoryEntry[];
  producerFactId: string;
};

export function heldFreshnessActivity(input: HeldFreshnessActivityInput): HeldFreshnessActivity {
  const messageNoun = input.messageCount === 1 ? "message" : "messages";
  const title =
    input.action === "send"
      ? "Send held by freshness check"
      : input.action === "task_claim"
        ? "Task claim held by freshness check"
        : "Task update held by freshness check";
  const countLine =
    input.decision === "syncing_hold"
      ? `unreviewed synced context for this target: ${input.messageCount} ${messageNoun}`
      : `new messages: ${input.messageCount} newer ${messageNoun}`;
  const decisionLines =
    input.decision === "syncing_hold"
      ? [
          "reason: this target's latest synced context was not yet in your reviewed context",
          input.action === "send"
            ? "action: review the synced context before sending"
            : "action: review the synced context, then retry this action",
        ]
      : ["decision: local hold; review the newer context before retrying"];
  const text = [input.target ? `target: ${input.target}` : null, countLine, ...decisionLines]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  return {
    activityKind: "working",
    detailKind: "freshness_hold",
    detail: title,
    entries: [{ kind: "system", title, text }],
    producerFactId: input.producerFactId,
  };
}

/** Raft's `recordFreshnessDecisionActivity` message count (bundle 843455): the sync hold counts the
 * window it showed, a local hold counts what is actually pending; each falls back to the other. */
export function heldFreshnessMessageCount(input: {
  decision: "local_hold" | "syncing_hold";
  newMessageCount?: number;
  shownMessageCount?: number;
}): number {
  return input.decision === "syncing_hold"
    ? (input.shownMessageCount ?? input.newMessageCount ?? 0)
    : (input.newMessageCount ?? input.shownMessageCount ?? 0);
}
