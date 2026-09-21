import { WORKSPACE_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal";
import type { AgentMessageTransportResponse } from "../connection/daemon-connection";

/**
 * The daemon's own freshness decision for an outgoing send — the local half of Raft's
 * `planAgentInboxSideEffect`.
 *
 * Why it has to be local: a hold decided on the server is decided *per request attempt*, and the
 * Agent's read context moves between attempts (a `search`/`resolve`/`read` advances it). Observed
 * in production (task #58): one logical send was answered `local_hold` at 00:18:30 and, re-issued
 * by the send retry, answered `forward` at 00:19:30 — the message landed after the Agent had been
 * told "no target delivery occurred", and the Agent's deliberate `--send-draft` resend then
 * produced a **duplicate**. Deciding before any transport call makes a hold terminal: the held
 * request is never issued, so nothing can re-decide it.
 *
 * What stays on the server: the server owns the message store, so it is the only side that can see
 * context the daemon was never delivered (a first touch of a target that already has history) and
 * anything that arrives between this decision and the request. Its check therefore remains as the
 * race guard, and `syncing_hold` (`target_first_touch_recent_context`) is still its call — the
 * daemon has nothing to plan from when it has never seen the target. This module deliberately
 * returns no `syncing_hold`: pretending to know would hold sends the server would forward.
 */

/** Raft's four side-effect decisions. The daemon plans the first, second and fourth. */
export type AgentInboxFreshnessDecision = "forward" | "bypass" | "local_hold" | "syncing_hold";

/** What the daemon knows about one Agent's inbox state for the exact target being sent to. */
export type AgentInboxFreshnessInput = {
  /** `--send-draft --anyway`: the Agent's explicit decision to send despite unseen context. It
   * short-circuits every hold and is never refused — Raft's contract has no "denied" outcome. */
  continueAnyway: boolean;
  /** The model-visible boundary for this exact target; 0 means the Agent has never been shown
   * anything for it. */
  modelSeenSequence: number;
  /** Messages the daemon still counts as unseen for this exact target (its attention index). */
  pendingMessageCount: number;
  /** The newest sequence the daemon knows for this exact target, whether or not it is pending. */
  latestSequence: number;
};

export type AgentInboxFreshnessPlan =
  | { decision: "bypass"; reason: "continue_anyway" }
  | {
      decision: "local_hold";
      reason: "exact_target_pending";
      /** Raft's notice count: messages the Agent has not reviewed for this target. */
      newMessageCount: number;
      /** Raft's `seenUpToSeq` on a held response: the frontier the Agent must review to clear it. */
      seenUpToSeq: number;
    }
  | {
      decision: "forward";
      reason: "model_seen_boundary" | "no_exact_target_pending_or_recent_context";
    };

export function planAgentInboxFreshness(input: AgentInboxFreshnessInput): AgentInboxFreshnessPlan {
  if (input.continueAnyway) return { decision: "bypass", reason: "continue_anyway" };
  // Unreviewed messages on the exact target: the one hold the daemon can prove from its own state,
  // and the one that used to flip. Decided here, never sent, never re-decided.
  if (input.pendingMessageCount > 0)
    return {
      decision: "local_hold",
      reason: "exact_target_pending",
      newMessageCount: input.pendingMessageCount,
      seenUpToSeq: input.latestSequence,
    };
  return {
    decision: "forward",
    // Raft's two forward reasons, kept apart because they say different things in a log: the Agent
    // had a boundary and is caught up, or there was nothing for this target to begin with.
    reason:
      input.modelSeenSequence > 0
        ? "model_seen_boundary"
        : "no_exact_target_pending_or_recent_context",
  };
}

/** Raft 1.0.32 `DEFAULT_HELD_CONTEXT_LIMIT`: how many newer messages a held notice shows. */
export const HELD_CONTEXT_LIMIT = 3;

/** Raft 1.0.32 `apmHeldFreshnessAvailableActions("send")`: the same list the server puts on a held
 * response it decided (`agent-messages.service.ts`'s `HELD_SEND_AVAILABLE_ACTIONS`). Kept here as
 * well because a locally held send never reaches that code path; a shared home is worth doing
 * when the activity side (task #58's PR3) starts reading the list too. */
export const HELD_SEND_AVAILABLE_ACTIONS = ["check_messages", "send_draft", "send_anyway"] as const;

/**
 * The transport-shaped result of a locally held send. Shaped like what the server would have
 * answered (`AgentMessageTransportResponse`) so the caller's post-processing — the held-draft
 * refresh, the working-status activity, the response the CLI renders — stays one code path,
 * whether the hold was decided here or found by the server's race guard.
 *
 * The window is deliberately empty: the daemon knows a count for this target but not the bodies of
 * messages it was told about and no longer holds, so it reports the count and no previews rather
 * than inventing them (see the module header).
 */
export function locallyHeldSend(
  plan: Extract<AgentInboxFreshnessPlan, { decision: "local_hold" }>,
  input: {
    requestId: string;
    draftReholdCount: number;
    freshnessContextMode?: "inline" | "withheld";
  },
  /** The newest unreviewed messages the daemon can still show, oldest first (at most
   * `HELD_CONTEXT_LIMIT`). An empty window is honest: the count still holds, the notice simply has
   * no previews. The caller marks whatever it passes here as reviewed once the Agent has been shown
   * it — Raft's `recordConsumedSeqs(data.seenUpToSeq)` — which is what lets a resend through. */
  window: readonly AgentMessageTransportResponse["messages"][number][] = [],
): AgentMessageTransportResponse {
  return {
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    requestId: input.requestId,
    accepted: false,
    attentionCount: plan.newMessageCount,
    // The window rides `messages`, the field the daemon's response envelope already carries the
    // server's held window in (`agentMessageResponseShape` adapts `heldMessages` onto it).
    messages: [...window],
    state: "held",
    decision: plan.decision,
    reason: plan.reason,
    availableActions: [...HELD_SEND_AVAILABLE_ACTIONS],
    // Same rule the server applies: a draft that has already been held once may be forced with
    // `--anyway`, which is exactly what the Agent is told here.
    continueAnywaySuggested: input.draftReholdCount >= 1,
    newMessageCount: plan.newMessageCount,
    shownMessageCount: window.length,
    omittedMessageCount: Math.max(0, plan.newMessageCount - window.length),
    // Raft's held response always carries the frontier it presented; the daemon records it as the
    // consumed boundary and keeps it in the draft, exactly as Raft's CLI does with
    // `recordConsumedSeqs(data.seenUpToSeq)` + `setSavedDraft({ seenUpToSeq })`.
    seenUpToSeq: plan.seenUpToSeq,
    ...(input.freshnessContextMode ? { freshnessContextMode: input.freshnessContextMode } : {}),
  };
}
