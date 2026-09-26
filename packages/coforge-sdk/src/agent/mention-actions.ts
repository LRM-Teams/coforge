/**
 * Wire contract for `coforge mention pending`, `coforge mention notify` and `coforge mention add`:
 * the sender's mentions
 * that reached no one because the target was outside the conversation at send time, and what the
 * sender asked to do about them. Uses the same `{ ok: false, errorCode, error }` error envelope as
 * the `profile` and `user info` routes.
 */

import { isRecord } from "../internal";
import type { AgentPendingMentionAction } from "#src/internal/local-daemon";

/** One of the sender's still-pending mentions, with the channel it was sent in (by name). */
export type AgentMentionPendingAction = AgentPendingMentionAction & { channelName: string };

/** Response for `GET /api/agent/v1/mention-actions/pending`. */
export type AgentMentionPendingResponse = {
  ok: true;
  pendingMentionActions: AgentMentionPendingAction[];
};

/** The actions a sender can request for its pending mentions: `notify` reaches the target
 * without making it a member; `add` makes it a member of the channel. */
export const AGENT_MENTION_ACTION_KINDS = ["notify", "add"] as const;
export type AgentMentionActionKind = (typeof AGENT_MENTION_ACTION_KINDS)[number];

export function isAgentMentionActionKind(value: unknown): value is AgentMentionActionKind {
  return (AGENT_MENTION_ACTION_KINDS as readonly unknown[]).includes(value);
}

/** Request body for `POST /api/agent/v1/mention-actions/execute`: one action on 1–20 resolution ids. */
export type AgentMentionExecuteRequest = {
  action: AgentMentionActionKind;
  resolutionIds: string[];
};

/** The outcome for one requested resolution id: `queued` is a notify's success, `delivered` an
 * add's. */
export type AgentMentionActionResult = {
  resolutionId: string;
  status: string;
  action?: string;
  reason?: string;
  messageId?: string;
  channelId?: string;
  targetType?: "user" | "agent";
  targetId?: string;
  /** The `@handle` the sender wrote, without the `@`. */
  targetHandle?: string;
};

/** Response for `POST /api/agent/v1/mention-actions/execute`. */
export type AgentMentionExecuteResponse = {
  ok: true;
  action: AgentMentionActionKind;
  results: AgentMentionActionResult[];
};

/** Most resolution ids one request may name. */
export const AGENT_MENTION_ACTION_MAX_IDS = 20;

export const AGENT_MENTION_ACTION_ERROR_CODES = ["invalid_request"] as const;
export type AgentMentionActionErrorCode = (typeof AGENT_MENTION_ACTION_ERROR_CODES)[number];

export type AgentMentionActionErrorResponse = {
  ok: false;
  errorCode: AgentMentionActionErrorCode;
  error: string;
};

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isPendingAction(value: unknown): value is AgentMentionPendingAction {
  return (
    isRecord(value) &&
    typeof value.resolutionId === "string" &&
    typeof value.messageId === "string" &&
    (value.targetType === "user" || value.targetType === "agent") &&
    typeof value.targetHandle === "string" &&
    (value.targetAvatarUrl === null || typeof value.targetAvatarUrl === "string") &&
    value.reason === "not_member" &&
    Array.isArray(value.availableActions) &&
    value.availableActions.every((action) => typeof action === "string") &&
    typeof value.expiresAt === "string" &&
    typeof value.channelName === "string"
  );
}

function isActionResult(value: unknown): value is AgentMentionActionResult {
  return (
    isRecord(value) &&
    typeof value.resolutionId === "string" &&
    typeof value.status === "string" &&
    isOptionalString(value.action) &&
    isOptionalString(value.reason) &&
    isOptionalString(value.messageId) &&
    isOptionalString(value.channelId) &&
    (value.targetType === undefined ||
      value.targetType === "user" ||
      value.targetType === "agent") &&
    isOptionalString(value.targetId)
  );
}

export function decodeAgentMentionPendingResponse(value: unknown): AgentMentionPendingResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.pendingMentionActions) ||
    !value.pendingMentionActions.every(isPendingAction)
  )
    throw new Error("invalid Agent mention pending response");
  return { ok: true, pendingMentionActions: value.pendingMentionActions };
}

export function decodeAgentMentionExecuteResponse(value: unknown): AgentMentionExecuteResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isAgentMentionActionKind(value.action) ||
    !Array.isArray(value.results) ||
    !value.results.every(isActionResult)
  )
    throw new Error("invalid Agent mention action response");
  return { ok: true, action: value.action, results: value.results };
}

export function decodeAgentMentionActionErrorResponse(
  value: unknown,
): AgentMentionActionErrorResponse | undefined {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    typeof value.errorCode !== "string" ||
    !(AGENT_MENTION_ACTION_ERROR_CODES as readonly string[]).includes(value.errorCode) ||
    typeof value.error !== "string"
  )
    return undefined;
  return {
    ok: false,
    errorCode: value.errorCode as AgentMentionActionErrorCode,
    error: value.error,
  };
}
