import type { AgentManualErrorCode } from "@lrm/coforge-sdk/agent";
import { tokenizeManualQuery } from "./manual-search.server";

export const MANUAL_TOPIC_SLUG_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;
export const MANUAL_TOPIC_SLUG_MAX_LENGTH = 120;
export const MANUAL_QUERY_MAX_LENGTH = 200;
export const MANUAL_INTENT_REASON_MIN_LENGTH = 12;
export const MANUAL_INTENT_REASON_MAX_LENGTH = 500;

export type AgentManualFieldError = { errorCode: AgentManualErrorCode; error: string };

export function isValidManualTopicSlug(topic: string): boolean {
  return (
    topic.length > 0 &&
    topic.length <= MANUAL_TOPIC_SLUG_MAX_LENGTH &&
    MANUAL_TOPIC_SLUG_PATTERN.test(topic)
  );
}

function isValidIntentOrReasonValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed.length >= MANUAL_INTENT_REASON_MIN_LENGTH &&
    trimmed.length <= MANUAL_INTENT_REASON_MAX_LENGTH
  );
}

/**
 * Both `--intent` and `--reason` are required on every `manual` call (Raft-aligned): trimmed,
 * 12-500 characters. When both are invalid, a single error names both rather than only the first
 * one checked, so a caller does not have to fix them one at a time.
 */
export function validateManualIntentReason(
  intent: unknown,
  reason: unknown,
): AgentManualFieldError | undefined {
  const intentValid = isValidIntentOrReasonValue(intent);
  const reasonValid = isValidIntentOrReasonValue(reason);
  if (intentValid && reasonValid) return undefined;
  const range = `${MANUAL_INTENT_REASON_MIN_LENGTH}-${MANUAL_INTENT_REASON_MAX_LENGTH}`;
  const safetyNote =
    "Never put a raw prompt, a credential, a private URL, or a message payload in either field.";
  if (!intentValid && !reasonValid)
    return {
      errorCode: "knowledge_intent_invalid",
      error:
        `--intent and --reason are both required and must be ${range} characters after ` +
        `trimming. --intent is what you ultimately want to accomplish; --reason is why the ` +
        `Manual is needed at this point. ${safetyNote}`,
    };
  if (!intentValid)
    return {
      errorCode: "knowledge_intent_invalid",
      error:
        `--intent is required and must be ${range} characters after trimming: state what you ` +
        `ultimately want to accomplish. ${safetyNote}`,
    };
  return {
    errorCode: "knowledge_reason_invalid",
    error:
      `--reason is required and must be ${range} characters after trimming: state why the ` +
      `Manual is needed at this point. ${safetyNote}`,
  };
}

export function validateManualQuery(query: unknown): AgentManualFieldError | undefined {
  if (
    typeof query !== "string" ||
    query.trim().length > MANUAL_QUERY_MAX_LENGTH ||
    tokenizeManualQuery(query).length === 0
  )
    return {
      errorCode: "knowledge_query_invalid",
      error:
        `Search query is required, must contain at least one keyword of two or more ` +
        `characters, and must be at most ${MANUAL_QUERY_MAX_LENGTH} characters.`,
    };
  return undefined;
}
