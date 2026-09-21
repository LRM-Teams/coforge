/**
 * Wire contract for `coforge profile show [<target>]` and `coforge profile update`. Uses the same
 * `{ ok: false, errorCode, error }` error envelope as the Agent Manual and `user info` routes.
 *
 * CoForge divergence from the reference product this command grammar is modelled on: there is no
 * Agent avatar (only `User.avatarObjectKey` exists in the schema — no equivalent column or upload
 * flow for `Agent`), so there is no `avatarUrl` field or `--avatar-url` update flag here. A human
 * profile's `createdAgents` lists Agents the human owns (`Agent.ownerId`); an Agent profile never
 * carries `createdAgents` itself, because `Agent.ownerId` always references a human `User` in
 * CoForge's schema — an Agent can never own another Agent (ADR 0025: Agent creation is
 * human-committed only).
 */

import type { AgentUserStatus } from "./user-info";

export type AgentProfileShowRequest = { target?: string };

export type AgentProfileCreatedAgent = {
  name: string;
  displayName: string;
  status: AgentUserStatus;
};

export type AgentProfileCreator = {
  name: string;
  displayName: string;
};

export type AgentProfileView =
  | {
      kind: "human";
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
      isSelf: boolean;
      createdAgents: AgentProfileCreatedAgent[];
    }
  | {
      kind: "agent";
      id: string;
      name: string;
      displayName: string;
      description: string;
      role: string | null;
      isSelf: boolean;
      runtime: string;
      model: string;
      computerName?: string;
      status: AgentUserStatus;
      availability?: string;
      creator: AgentProfileCreator | null;
    };

/** Response for `GET /api/agent/v1/profile[?target=<name>]`. */
export type AgentProfileShowResponse = {
  ok: true;
  profile: AgentProfileView;
};

/** Request body for `POST /api/agent/v1/profile`. Applies to the calling Agent only; the
 * Username (`name`) is fixed at creation and is never accepted here. */
export type AgentProfileUpdateRequest = {
  displayName?: string;
  description?: string;
};

/** Response for `POST /api/agent/v1/profile`: the calling Agent's updated profile. */
export type AgentProfileUpdateResponse = {
  ok: true;
  profile: AgentProfileView & { kind: "agent" };
};

/** `agent_not_visible` (ADR 0059): see `user-info.ts`'s matching code — the same distinction
 * applies to `profile show`'s target resolution. */
export const AGENT_PROFILE_ERROR_CODES = [
  "user_not_found",
  "profile_invalid",
  "agent_not_visible",
] as const;
export type AgentProfileErrorCode = (typeof AGENT_PROFILE_ERROR_CODES)[number];

export type AgentProfileErrorResponse = {
  ok: false;
  errorCode: AgentProfileErrorCode;
  error: string;
};

function isProfileErrorCode(value: unknown): value is AgentProfileErrorCode {
  return (
    typeof value === "string" && (AGENT_PROFILE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function decodeAgentProfileErrorResponse(
  value: unknown,
): AgentProfileErrorResponse | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== false ||
    !("errorCode" in value) ||
    !isProfileErrorCode(value.errorCode) ||
    !("error" in value) ||
    typeof value.error !== "string"
  )
    return undefined;
  return { ok: false, errorCode: value.errorCode, error: value.error };
}

function isCreatedAgent(value: unknown): value is AgentProfileCreatedAgent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.displayName === "string" &&
    (candidate.status === "online" ||
      candidate.status === "offline" ||
      candidate.status === "unknown")
  );
}

function isProfileView(value: unknown): value is AgentProfileView {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.displayName !== "string" ||
    typeof candidate.description !== "string" ||
    (candidate.role !== null && typeof candidate.role !== "string") ||
    typeof candidate.isSelf !== "boolean"
  )
    return false;
  if (candidate.kind === "human")
    return Array.isArray(candidate.createdAgents) && candidate.createdAgents.every(isCreatedAgent);
  if (candidate.kind === "agent")
    return (
      typeof candidate.runtime === "string" &&
      typeof candidate.model === "string" &&
      (candidate.status === "online" ||
        candidate.status === "offline" ||
        candidate.status === "unknown") &&
      (candidate.creator === null ||
        (typeof candidate.creator === "object" &&
          candidate.creator !== null &&
          typeof (candidate.creator as Record<string, unknown>).name === "string" &&
          typeof (candidate.creator as Record<string, unknown>).displayName === "string"))
    );
  return false;
}

export function decodeAgentProfileShowResponse(value: unknown): AgentProfileShowResponse {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("profile" in value) ||
    !isProfileView((value as { profile: unknown }).profile)
  )
    throw new Error("invalid Agent profile show response");
  return { ok: true, profile: (value as { profile: AgentProfileView }).profile };
}

export function decodeAgentProfileUpdateResponse(value: unknown): AgentProfileUpdateResponse {
  const decoded = decodeAgentProfileShowResponse(value);
  if (decoded.profile.kind !== "agent")
    throw new Error("invalid Agent profile update response: expected an agent profile");
  return { ok: true, profile: decoded.profile };
}
