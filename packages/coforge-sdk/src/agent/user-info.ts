/**
 * Wire contract for `coforge user info <name>`: narrow visible facts about one human or Agent in
 * the caller's Workspace, plus the public channels both the caller and the target belong to.
 * Uses the same `{ ok: false, errorCode, error }` error envelope as the Agent Manual routes (ADR
 * 0036), per that record's convention for a small, single-purpose Agent-facing lookup.
 */

export type AgentUserKind = "human" | "agent";

export type AgentUserInfoRequest = { name: string };

/** Live lifecycle, sourced from the same Agent display projection the Workspace Agents list
 * uses (`agent-display.server.ts`); "unknown" when the Agent has no assigned Computer or the
 * display snapshot could not be read. Absent entirely for a human. */
export type AgentUserStatus = "online" | "offline" | "unknown";

export type AgentUserInfo = {
  kind: AgentUserKind;
  id: string;
  name: string;
  displayName: string;
  description: string;
  /** Workspace role for a human; the Agent's own server role (ADR 0024) for an Agent. Never
   * `null` in practice today (both default to `"member"`), but typed nullable defensively. */
  role: string | null;
  isSelf: boolean;
  /** Agent-only fields below; absent for a human. */
  computerName?: string;
  runtime?: string;
  model?: string;
  status?: AgentUserStatus;
  /** Present only when there is a persisted reason the Agent will not respond even while its
   * process may be reachable (ADR 0038's `stoppedAt`, surfaced only while the display itself
   * already reads offline — never a transient in-flight control state). */
  availability?: string;
};

export type AgentUserInfoMembership = {
  channel: string;
  /** The target's own stored `ConversationMember.channelRole`; absent when unknown. */
  role?: string;
};

/** Response for `GET /api/agent/v1/users/:name`. */
export type AgentUserInfoResponse = {
  ok: true;
  user: AgentUserInfo;
  memberships: AgentUserInfoMembership[];
};

export const AGENT_USER_INFO_ERROR_CODES = ["user_not_found"] as const;
export type AgentUserInfoErrorCode = (typeof AGENT_USER_INFO_ERROR_CODES)[number];

export type AgentUserInfoErrorResponse = {
  ok: false;
  errorCode: AgentUserInfoErrorCode;
  error: string;
};

function isUserInfoErrorCode(value: unknown): value is AgentUserInfoErrorCode {
  return (
    typeof value === "string" && (AGENT_USER_INFO_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function decodeAgentUserInfoErrorResponse(
  value: unknown,
): AgentUserInfoErrorResponse | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== false ||
    !("errorCode" in value) ||
    !isUserInfoErrorCode(value.errorCode) ||
    !("error" in value) ||
    typeof value.error !== "string"
  )
    return undefined;
  return { ok: false, errorCode: value.errorCode, error: value.error };
}

function isUserInfoMembership(value: unknown): value is AgentUserInfoMembership {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { channel?: unknown; role?: unknown };
  return (
    typeof candidate.channel === "string" &&
    (candidate.role === undefined || typeof candidate.role === "string")
  );
}

export function decodeAgentUserInfoResponse(value: unknown): AgentUserInfoResponse {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true)
    throw new Error("invalid Agent user info response");
  const candidate = value as { user?: unknown; memberships?: unknown };
  const user = candidate.user;
  if (!user || typeof user !== "object")
    throw new Error("invalid Agent user info response: missing user");
  const u = user as Record<string, unknown>;
  if (
    (u.kind !== "human" && u.kind !== "agent") ||
    typeof u.id !== "string" ||
    typeof u.name !== "string" ||
    typeof u.displayName !== "string" ||
    typeof u.description !== "string" ||
    (u.role !== null && typeof u.role !== "string") ||
    typeof u.isSelf !== "boolean"
  )
    throw new Error("invalid Agent user info response: malformed user");
  if (!Array.isArray(candidate.memberships) || !candidate.memberships.every(isUserInfoMembership))
    throw new Error("invalid Agent user info response: malformed memberships");
  return {
    ok: true,
    user: u as unknown as AgentUserInfo,
    memberships: candidate.memberships,
  };
}
