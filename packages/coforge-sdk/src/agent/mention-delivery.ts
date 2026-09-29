/**
 * Wire contract for mention delivery, `coforge mention delivery --message <id>`: for a message the
 * calling Agent sent, what became of each @mention of an Agent in it. Errors use the `{ ok: false,
 * errorCode, error }` envelope with this lookup's own codes; a message the Agent did not send
 * answers `message_not_found`, exactly like one that does not exist.
 */

import { isRecord } from "#src/internal/json-record";

/** `pending` has not settled; `unknown` means delivery tracking could not see the result, and
 * may still become `delivered`. `delivered` and `lost` are final. */
export const AGENT_MENTION_DELIVERY_OUTCOMES = ["pending", "delivered", "lost", "unknown"] as const;
export type AgentMentionDeliveryOutcome = (typeof AGENT_MENTION_DELIVERY_OUTCOMES)[number];

/** Why a `lost` mention was lost. */
export const AGENT_MENTION_DELIVERY_REASON_CATEGORIES = [
  "quota",
  "runtime_error",
  "not_launched",
  "unclassified",
] as const;
export type AgentMentionDeliveryReasonCategory =
  (typeof AGENT_MENTION_DELIVERY_REASON_CATEGORIES)[number];

/** One @mentioned Agent: the `@handle` the sender wrote, whether that Agent has since been
 * deleted, and the outcome. A lost mention always carries its reason category; no other outcome
 * does. */
export type AgentMentionDelivery = { targetHandle: string; targetDeleted?: true } & (
  | { outcome: "lost"; reasonCategory: AgentMentionDeliveryReasonCategory }
  | { outcome: Exclude<AgentMentionDeliveryOutcome, "lost"> }
);

/** What the local Proxy hands the daemon: the message by full id or eight-hex prefix. */
export type AgentMentionDeliveryRequest = { messageId: string };

/** Response for `GET /api/agent/v1/messages/:messageId/mention-deliveries`; `messageId` is the
 * message's full id, whichever form the request named it by. */
export type AgentMentionDeliveryResponse = {
  ok: true;
  messageId: string;
  deliveries: AgentMentionDelivery[];
};

/** `message_not_found`: the Agent sent no message with that id (or prefix). `ambiguous_message_id`:
 * a prefix names more than one message the Agent sent. */
export const AGENT_MENTION_DELIVERY_ERROR_CODES = [
  "message_not_found",
  "ambiguous_message_id",
] as const;
export type AgentMentionDeliveryErrorCode = (typeof AGENT_MENTION_DELIVERY_ERROR_CODES)[number];

export type AgentMentionDeliveryErrorResponse = {
  ok: false;
  errorCode: AgentMentionDeliveryErrorCode;
  error: string;
};

function isDelivery(value: unknown): value is AgentMentionDelivery {
  if (
    !isRecord(value) ||
    typeof value.targetHandle !== "string" ||
    !value.targetHandle.startsWith("@") ||
    (value.targetDeleted !== undefined && value.targetDeleted !== true)
  )
    return false;
  if (value.outcome === "lost")
    return (AGENT_MENTION_DELIVERY_REASON_CATEGORIES as readonly unknown[]).includes(
      value.reasonCategory,
    );
  return (
    (AGENT_MENTION_DELIVERY_OUTCOMES as readonly unknown[]).includes(value.outcome) &&
    value.reasonCategory === undefined
  );
}

export function decodeAgentMentionDeliveryResponse(value: unknown): AgentMentionDeliveryResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.messageId !== "string" ||
    !Array.isArray(value.deliveries) ||
    !value.deliveries.every(isDelivery)
  )
    throw new Error("invalid Agent mention delivery response");
  return { ok: true, messageId: value.messageId, deliveries: value.deliveries };
}

export function decodeAgentMentionDeliveryErrorResponse(
  value: unknown,
): AgentMentionDeliveryErrorResponse | undefined {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    typeof value.errorCode !== "string" ||
    !(AGENT_MENTION_DELIVERY_ERROR_CODES as readonly string[]).includes(value.errorCode) ||
    typeof value.error !== "string"
  )
    return undefined;
  return {
    ok: false,
    errorCode: value.errorCode as AgentMentionDeliveryErrorCode,
    error: value.error,
  };
}
