import type {
  AgentMentionActionKind,
  AgentMentionActionResult,
  AgentMentionDelivery,
  AgentMentionPendingAction,
} from "@lrm/coforge-sdk/agent";
import { withOutputMode, type CliError, type CliErrorOutputMode } from "#src/cli-error";
import { NON_MEMBER_MENTION_NOTICE, mentionRecoveryVerbs } from "#src/message-format";

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
    lines.push(`- ${action.resolutionId} — ${action.targetHandle} (${action.targetType})`);
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
  const lines = [`Mention ${action} results`, ""];
  if (!results.length) {
    lines.push("No result rows returned.");
    return lines.join("\n");
  }
  for (const result of results) {
    const detail = resultDetail(result);
    lines.push(
      `- ${result.resolutionId}${result.targetHandle ? ` ${result.targetHandle}` : ""}: ${result.status}${detail ? ` — ${detail}` : ""}`,
    );
  }
  if (results.some((result) => result.status === "queued" && result.reason !== "already_queued"))
    lines.push("", RECIPIENT_GUIDANCE);
  return lines.join("\n");
}

/** What a result row says after its status: the server's reason, and for a dropped notification
 * that it was not delivered. */
function resultDetail(result: AgentMentionActionResult): string | undefined {
  if (result.status === "dropped")
    return result.reason ? `not delivered: ${result.reason}` : "not delivered";
  return result.reason;
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

const ROUTE_ELSEWHERE = "Route the request another way.";

/** What one tracked @mention's outcome means for the sender, and what to do about it. */
function describeMentionDelivery(delivery: AgentMentionDelivery): string {
  switch (delivery.outcome) {
    case "delivered":
      return "delivered — it reached the Agent's running session.";
    case "pending":
      return "pending — not settled yet. Do not conclude that it arrived or that it was lost.";
    case "unknown":
      return "unknown — delivery tracking could not see whether it arrived. Do not conclude either way.";
    case "lost":
      switch (delivery.reasonCategory) {
        case "quota":
          return "lost (quota) — the Agent is rate- or quota-limited, so this mention will not arrive. Route the request another way, or retry later.";
        case "runtime_error":
          return `lost (runtime_error) — the Agent's runtime refused the mention. ${ROUTE_ELSEWHERE}`;
        case "not_launched":
          return "lost (not_launched) — the Agent was not running and was not started. Ask a person to start it, or route the request another way.";
        case "unclassified":
          return `lost (unclassified) — lost for a reason outside the known categories. ${ROUTE_ELSEWHERE}`;
      }
  }
}

/**
 * `coforge mention delivery`: one line per Agent the message @mentioned, with its outcome and the
 * next step; a closing re-check command while any outcome is still open.
 */
export function formatMentionDeliveries(
  messageId: string,
  deliveries: readonly AgentMentionDelivery[],
): string {
  const lines = [`Mention delivery for message ${messageId}`, ""];
  if (!deliveries.length) {
    lines.push(
      "No tracked @mentions: only @mentions of Agents this message was delivered to are tracked. For @mentions that reached no one, run coforge mention pending",
    );
    return lines.join("\n");
  }
  for (const delivery of deliveries)
    lines.push(
      `- ${delivery.targetHandle}${delivery.targetDeleted ? " (deleted)" : ""}: ${describeMentionDelivery(delivery)}`,
    );
  if (deliveries.some(({ outcome }) => outcome === "pending" || outcome === "unknown"))
    lines.push("", `Check again later: coforge mention delivery --message ${messageId}`);
  return lines.join("\n");
}

/** Where the id of a message the Agent sent can be found, as a runnable next step. */
export const MENTION_DELIVERY_MESSAGE_ID_HINT =
  "Use the Message ID `coforge message send` printed, or the msg= id of your own message in coforge message read --target <target>, then run coforge mention delivery --message <id>";

/** The next step for a failed `coforge mention delivery`. */
function mentionDeliveryNextAction(error: CliError, messageId: string): string {
  if (error.code === "MESSAGE_NOT_FOUND")
    return `Only a message you sent can be checked. ${MENTION_DELIVERY_MESSAGE_ID_HINT}`;
  if (error.code === "AMBIGUOUS_MESSAGE_ID")
    return "Use the full Message ID `coforge message send` printed: coforge mention delivery --message <full-id>";
  if (error.retryable)
    return `This lookup changes nothing, so it is safe to repeat: coforge mention delivery --message ${messageId}`;
  return `Fix the reason above, then run coforge mention delivery --message ${messageId} again`;
}

/** A failed `coforge mention delivery`, in the invocation's output mode, with the next step its
 * cause calls for. */
export function mentionDeliveryFailure(
  error: CliError,
  messageId: string,
  outputMode: CliErrorOutputMode,
): CliError {
  return withOutputMode(error, outputMode, {
    suggestedNextAction: mentionDeliveryNextAction(error, messageId),
  });
}
