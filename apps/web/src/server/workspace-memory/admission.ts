import { sanitizeWorkspaceMemoryFailure, type SanitizedFailure } from "./errors";
import type { ActivationCursor, WorkspaceMemoryProfile } from "./profile";

export const ADMITTED_SEGMENT_KINDS = ["completed_task", "quiet_window"] as const;
export type AdmittedSegmentKind = (typeof ADMITTED_SEGMENT_KINDS)[number];

export type AdmittedPublicChannelSegment = {
  segmentId: string;
  sourceMessageIds: readonly string[];
  workspace: {
    workspaceId: string;
    channelId: string;
  };
  kind: AdmittedSegmentKind;
  conversationKind: "public_channel";
  sourcePayloadHash: string;
  profileGeneration: number;
  closedAt: string;
};

export type AdmissionDecision =
  | { admit: true }
  | {
      admit: false;
      reason:
        | "profile_off"
        | "not_ready"
        | "stale_generation"
        | "before_activation_cursor"
        | "workspace_mismatch";
    };

export function decodeAdmittedPublicChannelSegment(
  value: unknown,
): AdmittedPublicChannelSegment | SanitizedFailure {
  if (!value || typeof value !== "object") return sanitizeWorkspaceMemoryFailure("invalid_segment");
  const input = value as Record<string, unknown>;
  const workspace = input.workspace;
  if (!workspace || typeof workspace !== "object") {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  const metadata = workspace as Record<string, unknown>;
  if (typeof input.segmentId !== "string" || input.segmentId.length === 0) {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  if (
    !Array.isArray(input.sourceMessageIds) ||
    input.sourceMessageIds.length === 0 ||
    input.sourceMessageIds.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  if (typeof metadata.workspaceId !== "string" || typeof metadata.channelId !== "string") {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  if (!(ADMITTED_SEGMENT_KINDS as readonly string[]).includes(input.kind as string)) {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  if (input.conversationKind !== "public_channel") {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  if (typeof input.sourcePayloadHash !== "string" || input.sourcePayloadHash.length === 0) {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  if (!Number.isInteger(input.profileGeneration) || (input.profileGeneration as number) < 0) {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }
  if (typeof input.closedAt !== "string" || Number.isNaN(Date.parse(input.closedAt))) {
    return sanitizeWorkspaceMemoryFailure("invalid_segment");
  }

  return Object.freeze({
    segmentId: input.segmentId,
    sourceMessageIds: Object.freeze([...input.sourceMessageIds]),
    workspace: Object.freeze({
      workspaceId: metadata.workspaceId,
      channelId: metadata.channelId,
    }),
    kind: input.kind as AdmittedSegmentKind,
    conversationKind: "public_channel",
    sourcePayloadHash: input.sourcePayloadHash,
    profileGeneration: input.profileGeneration as number,
    closedAt: input.closedAt,
  });
}

/**
 * The one definition of "the same admitted segment" for replay checks: every immutable field
 * matches. Both stores compare through this — the Prisma repository and the in-memory dispatch
 * store — so a replay can never be accepted by one and rejected by the other. `segmentId` and
 * `workspaceId` are absent because they are the lookup key the caller already matched on.
 */
export function sameAdmittedSegmentLineage(
  stored: AdmittedPublicChannelSegment,
  incoming: AdmittedPublicChannelSegment,
): boolean {
  return (
    stored.kind === incoming.kind &&
    stored.conversationKind === incoming.conversationKind &&
    stored.sourcePayloadHash === incoming.sourcePayloadHash &&
    stored.profileGeneration === incoming.profileGeneration &&
    stored.closedAt === incoming.closedAt &&
    stored.workspace.channelId === incoming.workspace.channelId &&
    stored.sourceMessageIds.length === incoming.sourceMessageIds.length &&
    stored.sourceMessageIds.every((id, index) => id === incoming.sourceMessageIds[index])
  );
}

export function isAfterActivationCursor(
  cursor: ActivationCursor | null,
  occurredAt: string,
): boolean {
  return cursor !== null && occurredAt > cursor.occurredAt;
}

export function canAdmitSegment(
  profile: WorkspaceMemoryProfile,
  segment: AdmittedPublicChannelSegment,
): AdmissionDecision {
  if (profile.desired === "off") return { admit: false, reason: "profile_off" };
  if (profile.observed !== "ready" && profile.observed !== "degraded") {
    return { admit: false, reason: "not_ready" };
  }
  if (segment.workspace.workspaceId !== profile.workspaceId) {
    return { admit: false, reason: "workspace_mismatch" };
  }
  if (segment.profileGeneration !== profile.generation) {
    return { admit: false, reason: "stale_generation" };
  }
  if (!isAfterActivationCursor(profile.activationCursor, segment.closedAt)) {
    return { admit: false, reason: "before_activation_cursor" };
  }
  return { admit: true };
}
