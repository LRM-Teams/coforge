import type {
  AgentMentionActionKind,
  AgentMentionActionResult,
  AgentMentionPendingAction,
} from "@lrm/coforge-sdk/agent";
import {
  NON_MEMBER_MENTION_NOTICE,
  authoredMentionToken,
  mentionRecoveryVerbs,
} from "#src/message-format";

/** The result status that means an action reached its target. */
const COMPLETED_STATUS: Record<AgentMentionActionKind, string> = {
  notify: "queued",
  add: "delivered",
};

/** What a notified target is told about replying, since it is not a member of the channel. */
const RECIPIENT_GUIDANCE = `Recipient guidance: ${NON_MEMBER_MENTION_NOTICE}`;

/**
 * `coforge mention pending`: each of the sender's mentions that reached no one, when it can no
 * longer be acted on, and the `coforge mention` commands it still allows.
 */
export function formatPendingMentionActions(actions: readonly AgentMentionPendingAction[]): string {
  const lines = ["Pending mention actions", ""];
  if (!actions.length) {
    lines.push("No pending mention actions.");
    return lines.join("\n");
  }
  for (const action of actions) {
    lines.push(
      `- ${action.resolutionId} — ${authoredMentionToken(action.targetHandle)} (${action.targetType})`,
    );
    lines.push(`  message: ${action.messageId}`);
    lines.push("  reason: not in the conversation at send time, so the @mention was not delivered");
    lines.push(`  expires: ${action.expiresAt}`);
    const verbs = mentionRecoveryVerbs(action);
    if (!verbs.length) continue;
    lines.push("  recovery commands:");
    for (const verb of verbs)
      lines.push(`  ${verb}: coforge mention ${verb} ${action.resolutionId}`);
    if (verbs.includes("notify"))
      lines.push("  note: notify exits nonzero unless the target queue accepts the delivery.");
  }
  return lines.join("\n");
}

/**
 * `coforge mention notify|add`: one line per requested target with its outcome, then what a newly
 * notified target was told about replying.
 */
export function formatMentionActionResults(
  action: AgentMentionActionKind,
  results: readonly AgentMentionActionResult[],
): string {
  const lines = [
    `Mention ${action} results`,
    "",
    ...results.map(
      (result) =>
        `- ${result.resolutionId}: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`,
    ),
  ];
  if (results.some((result) => result.status === "queued" && result.reason !== "already_queued"))
    lines.push("", RECIPIENT_GUIDANCE);
  return lines.join("\n");
}

/**
 * The requested ids that did not reach their target, each as `<id>: <status> (<reason>)`; an id
 * the server answered nothing for is `<id>: missing_result`. Empty when every target was reached.
 */
export function incompleteMentionActions(
  action: AgentMentionActionKind,
  resolutionIds: readonly string[],
  results: readonly AgentMentionActionResult[],
): string[] {
  const byId = new Map(results.map((result) => [result.resolutionId, result]));
  return [...new Set(resolutionIds)].flatMap((id) => {
    const result = byId.get(id);
    if (!result) return [`${id}: missing_result`];
    if (result.status === COMPLETED_STATUS[action]) return [];
    return [`${id}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`];
  });
}
