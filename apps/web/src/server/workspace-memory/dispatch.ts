/**
 * P4 port extension: one-sink admitted-segment dispatch.
 * Consumes the P3 ledger shape without editing the frozen C1 DTO or P3 adapters.
 */
import {
  canAdmitSegment,
  decodeAdmittedPublicChannelSegment,
  sameAdmittedSegmentLineage,
  type AdmittedPublicChannelSegment,
} from "./admission";
import {
  ingestOperationId,
  type AdmissionTurn,
  type DetectedPublicChannelSegment,
} from "./detect-segments";
import type { DesiredWorkspaceMemoryProfile, WorkspaceMemoryProfile } from "./profile";

export const DISPATCH_STATES = ["pending", "delivered", "retryable_failure"] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const DISPATCH_SINK_PROFILES = ["openviking"] as const;
export type DispatchSinkProfile = (typeof DISPATCH_SINK_PROFILES)[number];

export type AdmittedSegmentDispatchRecord = {
  workspaceId: string;
  segmentId: string;
  operationId: string;
  sinkProfile: DispatchSinkProfile;
  profileGeneration: number;
  state: DispatchState;
  attemptCount: number;
  sanitizedError?: string;
  updatedAt?: string;
};

export type ConsumeDispatchInput = {
  workspaceId: string;
  segmentId: string;
  operationId: string;
  sinkProfile: DispatchSinkProfile;
  profileGeneration: number;
};

export type ConsumeDispatchResult =
  | { outcome: "accepted"; dispatch: AdmittedSegmentDispatchRecord }
  | { outcome: "replay"; dispatch: AdmittedSegmentDispatchRecord };

export type PutSegmentResult =
  | { outcome: "saved"; segment: AdmittedPublicChannelSegment }
  | { outcome: "replay"; segment: AdmittedPublicChannelSegment };

export type WorkspaceMemoryAdmissionPort = {
  putSegment(segment: AdmittedPublicChannelSegment): Promise<PutSegmentResult>;
  getSegment(workspaceId: string, segmentId: string): Promise<AdmittedPublicChannelSegment | null>;
  consumeDispatch(input: ConsumeDispatchInput): Promise<ConsumeDispatchResult>;
  getDispatch(
    workspaceId: string,
    segmentId: string,
  ): Promise<AdmittedSegmentDispatchRecord | null>;
  markDispatchState(input: {
    workspaceId: string;
    operationId: string;
    state: Exclude<DispatchState, "pending">;
    sanitizedError?: string;
  }): Promise<AdmittedSegmentDispatchRecord>;
};

export class AdmissionReplayConflictError extends Error {
  constructor(readonly operationId: string) {
    super(`workspace memory operation ${operationId} drifted`);
    this.name = "AdmissionReplayConflictError";
  }
}

export type AdmissionSinkDelivery = {
  segment: AdmittedPublicChannelSegment;
  operationId: string;
  turns: readonly AdmissionTurn[];
  offerMessageIds?: ReadonlySet<string>;
};

export type AdmissionSinkResult =
  | { outcome: "delivered" }
  | { outcome: "retryable_failure"; sanitizedError: string };

export type AdmissionSink = {
  deliver(input: AdmissionSinkDelivery): Promise<AdmissionSinkResult>;
};

export type DispatchOutcome =
  | {
      outcome: "skipped";
      reason:
        | "profile_off"
        | "not_ready"
        | "stale_generation"
        | "before_activation_cursor"
        | "workspace_mismatch"
        | "invalid_segment"
        | "replay_conflict";
    }
  | { outcome: "dispatched"; sinkProfile: DispatchSinkProfile; replay: boolean }
  | { outcome: "replayed"; sinkProfile: DispatchSinkProfile }
  | { outcome: "retryable_failure"; sanitizedError: string };

export type AdmissionDispatcher = {
  dispatch(input: {
    profile: WorkspaceMemoryProfile;
    detected: DetectedPublicChannelSegment;
    admitted?: AdmittedPublicChannelSegment;
    sinkProfile?: DispatchSinkProfile;
    offerMessageIds?: ReadonlySet<string>;
  }): Promise<DispatchOutcome>;
};

export function asDispatchSinkProfile(
  desired: DesiredWorkspaceMemoryProfile,
): DispatchSinkProfile | null {
  return desired === "openviking" ? desired : null;
}

export function createAdmissionDispatcher(deps: {
  admission: WorkspaceMemoryAdmissionPort;
  sinks: Record<DispatchSinkProfile, AdmissionSink>;
}): AdmissionDispatcher {
  return {
    async dispatch(input) {
      const sinkProfile = input.sinkProfile ?? asDispatchSinkProfile(input.profile.desired);
      if (!sinkProfile) return { outcome: "skipped", reason: "profile_off" };
      const admitted = input.admitted ?? toAdmitted(input.detected, input.profile.generation);
      if (!admitted) return { outcome: "skipped", reason: "invalid_segment" };
      const decision = canAdmitSegment(input.profile, admitted);
      if (!decision.admit) return { outcome: "skipped", reason: decision.reason };

      let saved: PutSegmentResult;
      try {
        saved = await deps.admission.putSegment(admitted);
      } catch (error) {
        if (isReplayConflict(error)) {
          return { outcome: "skipped", reason: "replay_conflict" };
        }
        throw error;
      }
      let consumed: ConsumeDispatchResult;
      try {
        consumed = await deps.admission.consumeDispatch({
          workspaceId: admitted.workspace.workspaceId,
          segmentId: admitted.segmentId,
          operationId: ingestOperationId(admitted.segmentId),
          sinkProfile,
          profileGeneration: admitted.profileGeneration,
        });
      } catch (error) {
        if (isReplayConflict(error)) {
          return { outcome: "skipped", reason: "replay_conflict" };
        }
        throw error;
      }

      if (consumed.outcome === "replay" && consumed.dispatch.state === "delivered") {
        return { outcome: "replayed", sinkProfile: consumed.dispatch.sinkProfile };
      }

      const sink = deps.sinks[consumed.dispatch.sinkProfile];
      try {
        const result = await sink.deliver({
          segment: saved.segment,
          operationId: consumed.dispatch.operationId,
          turns: input.detected.turns,
          ...(input.offerMessageIds ? { offerMessageIds: input.offerMessageIds } : {}),
        });
        if (result.outcome === "delivered") {
          await deps.admission.markDispatchState({
            workspaceId: admitted.workspace.workspaceId,
            operationId: consumed.dispatch.operationId,
            state: "delivered",
          });
          return {
            outcome: "dispatched",
            sinkProfile: consumed.dispatch.sinkProfile,
            replay: consumed.outcome === "replay",
          };
        }
        await deps.admission.markDispatchState({
          workspaceId: admitted.workspace.workspaceId,
          operationId: consumed.dispatch.operationId,
          state: "retryable_failure",
          sanitizedError: result.sanitizedError,
        });
        return { outcome: "retryable_failure", sanitizedError: result.sanitizedError };
      } catch {
        const sanitizedError = "memory sink unavailable";
        await deps.admission.markDispatchState({
          workspaceId: admitted.workspace.workspaceId,
          operationId: consumed.dispatch.operationId,
          state: "retryable_failure",
          sanitizedError,
        });
        return { outcome: "retryable_failure", sanitizedError };
      }
    },
  };
}

export function createOpenVikingNativeSessionSink(
  deps: {
    commitSession?(delivery: AdmissionSinkDelivery): Promise<void>;
  } = {},
): AdmissionSink {
  return {
    async deliver(input) {
      try {
        await deps.commitSession?.(input);
        return { outcome: "delivered" };
      } catch {
        return {
          outcome: "retryable_failure",
          sanitizedError: "openviking native session unavailable",
        };
      }
    },
  };
}

export type InMemoryWorkspaceMemoryAdmissionStore = WorkspaceMemoryAdmissionPort & {
  listAdmittedMessageIds(workspaceId: string): Promise<Set<string>>;
  listRetryableDispatches(workspaceId: string): Promise<AdmittedSegmentDispatchRecord[]>;
};

export function createInMemoryWorkspaceMemoryAdmissionStore(deps?: {
  now?: () => Date;
}): InMemoryWorkspaceMemoryAdmissionStore {
  const now = deps?.now ?? (() => new Date());
  const segments = new Map<string, AdmittedPublicChannelSegment>();
  const dispatches = new Map<string, AdmittedSegmentDispatchRecord>();

  return {
    async putSegment(segment) {
      const decoded = decodeAdmittedPublicChannelSegment(segment);
      if ("code" in decoded) throw new AdmissionReplayConflictError("invalid");
      const key = segmentKey(decoded.workspace.workspaceId, decoded.segmentId);
      const existing = segments.get(key);
      if (existing) {
        if (!sameAdmittedSegmentLineage(existing, decoded)) {
          throw new AdmissionReplayConflictError(decoded.segmentId);
        }
        return { outcome: "replay", segment: existing };
      }
      segments.set(key, decoded);
      return { outcome: "saved", segment: decoded };
    },
    async getSegment(workspaceId, segmentId) {
      return segments.get(segmentKey(workspaceId, segmentId)) ?? null;
    },
    async consumeDispatch(input) {
      const segment = segments.get(segmentKey(input.workspaceId, input.segmentId));
      if (!segment) throw new AdmissionReplayConflictError(input.operationId);
      const existing =
        dispatches.get(segmentKey(input.workspaceId, input.segmentId)) ??
        [...dispatches.values()].find(
          (row) => row.workspaceId === input.workspaceId && row.operationId === input.operationId,
        );
      if (existing) {
        if (
          existing.segmentId === input.segmentId &&
          existing.operationId === input.operationId &&
          existing.sinkProfile === input.sinkProfile &&
          existing.profileGeneration === input.profileGeneration
        ) {
          return { outcome: "replay", dispatch: existing };
        }
        throw new AdmissionReplayConflictError(input.operationId);
      }
      const dispatch: AdmittedSegmentDispatchRecord = {
        workspaceId: input.workspaceId,
        segmentId: input.segmentId,
        operationId: input.operationId,
        sinkProfile: input.sinkProfile,
        profileGeneration: input.profileGeneration,
        state: "pending",
        attemptCount: 0,
        updatedAt: now().toISOString(),
      };
      dispatches.set(segmentKey(input.workspaceId, input.segmentId), dispatch);
      return { outcome: "accepted", dispatch };
    },
    async getDispatch(workspaceId, segmentId) {
      return dispatches.get(segmentKey(workspaceId, segmentId)) ?? null;
    },
    async markDispatchState(input) {
      const existing = [...dispatches.values()].find(
        (row) => row.workspaceId === input.workspaceId && row.operationId === input.operationId,
      );
      if (!existing) throw new AdmissionReplayConflictError(input.operationId);
      const next: AdmittedSegmentDispatchRecord = {
        ...existing,
        state: input.state,
        attemptCount:
          input.state === "retryable_failure" ? existing.attemptCount + 1 : existing.attemptCount,
        updatedAt: now().toISOString(),
        ...(input.sanitizedError ? { sanitizedError: input.sanitizedError } : {}),
      };
      dispatches.set(segmentKey(existing.workspaceId, existing.segmentId), next);
      return next;
    },
    async listAdmittedMessageIds(workspaceId) {
      const ids = new Set<string>();
      for (const segment of segments.values()) {
        if (segment.workspace.workspaceId !== workspaceId) continue;
        for (const messageId of segment.sourceMessageIds) ids.add(messageId);
      }
      return ids;
    },
    async listRetryableDispatches(workspaceId) {
      return [...dispatches.values()].filter(
        (row) =>
          row.workspaceId === workspaceId &&
          (row.state === "pending" || row.state === "retryable_failure"),
      );
    },
  };
}

function toAdmitted(
  detected: DetectedPublicChannelSegment,
  profileGeneration: number,
): AdmittedPublicChannelSegment | null {
  const decoded = decodeAdmittedPublicChannelSegment({
    segmentId: detected.segmentId,
    sourceMessageIds: detected.sourceMessageIds,
    workspace: detected.workspace,
    kind: detected.kind,
    conversationKind: detected.conversationKind,
    sourcePayloadHash: detected.sourcePayloadHash,
    profileGeneration,
    closedAt: detected.closedAt,
  });
  return "code" in decoded ? null : decoded;
}

function segmentKey(workspaceId: string, segmentId: string): string {
  return `${workspaceId}:${segmentId}`;
}

function isReplayConflict(error: unknown): boolean {
  return (
    error instanceof AdmissionReplayConflictError ||
    (error instanceof Error && error.name === "WorkspaceMemoryReplayConflictError")
  );
}
