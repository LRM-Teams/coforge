import type { PrismaClient } from "../../../../generated/client";
import {
  decodeAdmittedPublicChannelSegment,
  type AdmittedPublicChannelSegment,
} from "../../workspace-memory/admission";
import {
  isUniqueConstraintError,
  WorkspaceMemoryReplayConflictError,
  WorkspaceMemoryScopeError,
} from "./workspace-memory-errors.server";

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

export type WorkspaceMemoryAdmissionStore = {
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

type SegmentRow = {
  workspaceId: string;
  segmentId: string;
  channelId: string;
  kind: string;
  conversationKind: string;
  sourcePayloadHash: string;
  profileGeneration: number;
  closedAt: Date;
  sourceMessages: { messageId: string }[];
};

type DispatchRow = {
  workspaceId: string;
  segmentId: string;
  operationId: string;
  sinkProfile: string;
  profileGeneration: number;
  state: string;
  attemptCount: number;
  sanitizedError: string | null;
};

export class PrismaWorkspaceMemoryAdmissionStore implements WorkspaceMemoryAdmissionStore {
  constructor(private readonly db: PrismaClient) {}

  async putSegment(segment: AdmittedPublicChannelSegment): Promise<PutSegmentResult> {
    const decoded = decodeAdmittedPublicChannelSegment(segment);
    if ("code" in decoded) throw new WorkspaceMemoryScopeError();
    const existing = await this.db.admittedPublicChannelSegment.findUnique({
      where: {
        workspaceId_segmentId: {
          workspaceId: decoded.workspace.workspaceId,
          segmentId: decoded.segmentId,
        },
      },
      include: { sourceMessages: { orderBy: { createdAt: "asc" } } },
    });
    if (existing) {
      if (!sameLineage(existing, decoded)) {
        throw new WorkspaceMemoryReplayConflictError(decoded.segmentId);
      }
      return { outcome: "replay", segment: toSegment(existing) };
    }
    try {
      const row = await this.db.admittedPublicChannelSegment.create({
        data: {
          workspaceId: decoded.workspace.workspaceId,
          segmentId: decoded.segmentId,
          channelId: decoded.workspace.channelId,
          kind: decoded.kind,
          conversationKind: decoded.conversationKind,
          sourcePayloadHash: decoded.sourcePayloadHash,
          profileGeneration: decoded.profileGeneration,
          closedAt: new Date(decoded.closedAt),
          sourceMessages: {
            create: decoded.sourceMessageIds.map((messageId) => ({
              messageId,
              payloadHash: decoded.sourcePayloadHash,
            })),
          },
        },
        include: { sourceMessages: { orderBy: { createdAt: "asc" } } },
      });
      return { outcome: "saved", segment: toSegment(row) };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const replayed = await this.getSegment(decoded.workspace.workspaceId, decoded.segmentId);
      if (!replayed) throw new WorkspaceMemoryScopeError();
      if (!sameDecodedLineage(replayed, decoded)) {
        throw new WorkspaceMemoryReplayConflictError(decoded.segmentId);
      }
      return { outcome: "replay", segment: replayed };
    }
  }

  async getSegment(
    workspaceId: string,
    segmentId: string,
  ): Promise<AdmittedPublicChannelSegment | null> {
    const row = await this.db.admittedPublicChannelSegment.findUnique({
      where: { workspaceId_segmentId: { workspaceId, segmentId } },
      include: { sourceMessages: { orderBy: { createdAt: "asc" } } },
    });
    return row ? toSegment(row) : null;
  }

  async consumeDispatch(input: ConsumeDispatchInput): Promise<ConsumeDispatchResult> {
    if (!(DISPATCH_SINK_PROFILES as readonly string[]).includes(input.sinkProfile)) {
      throw new WorkspaceMemoryScopeError();
    }
    const segment = await this.getSegment(input.workspaceId, input.segmentId);
    if (!segment) throw new WorkspaceMemoryScopeError();
    const existing = await this.findDispatch(input.workspaceId, input.segmentId, input.operationId);
    if (existing) return replayOrConflict(existing, input);

    try {
      const row = await this.db.admittedSegmentDispatch.create({
        data: {
          workspaceId: input.workspaceId,
          segmentId: input.segmentId,
          operationId: input.operationId,
          sinkProfile: input.sinkProfile,
          profileGeneration: input.profileGeneration,
          state: "pending",
        },
      });
      return { outcome: "accepted", dispatch: toDispatch(row) };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.findDispatch(input.workspaceId, input.segmentId, input.operationId);
      if (!raced) throw new WorkspaceMemoryScopeError();
      return replayOrConflict(raced, input);
    }
  }

  async getDispatch(
    workspaceId: string,
    segmentId: string,
  ): Promise<AdmittedSegmentDispatchRecord | null> {
    const row = await this.db.admittedSegmentDispatch.findUnique({
      where: { workspaceId_segmentId: { workspaceId, segmentId } },
    });
    return row ? toDispatch(row) : null;
  }

  async markDispatchState(input: {
    workspaceId: string;
    operationId: string;
    state: Exclude<DispatchState, "pending">;
    sanitizedError?: string;
  }): Promise<AdmittedSegmentDispatchRecord> {
    const existing = await this.db.admittedSegmentDispatch.findUnique({
      where: {
        workspaceId_operationId: { workspaceId: input.workspaceId, operationId: input.operationId },
      },
    });
    if (!existing) throw new WorkspaceMemoryScopeError();
    const row = await this.db.admittedSegmentDispatch.update({
      where: {
        workspaceId_operationId: { workspaceId: input.workspaceId, operationId: input.operationId },
      },
      data: {
        state: input.state,
        sanitizedError: input.sanitizedError ?? null,
        attemptCount:
          input.state === "retryable_failure" ? existing.attemptCount + 1 : existing.attemptCount,
      },
    });
    return toDispatch(row);
  }

  private async findDispatch(
    workspaceId: string,
    segmentId: string,
    operationId: string,
  ): Promise<AdmittedSegmentDispatchRecord | null> {
    const bySegment = await this.db.admittedSegmentDispatch.findUnique({
      where: { workspaceId_segmentId: { workspaceId, segmentId } },
    });
    if (bySegment) return toDispatch(bySegment);
    const byOperation = await this.db.admittedSegmentDispatch.findUnique({
      where: { workspaceId_operationId: { workspaceId, operationId } },
    });
    return byOperation ? toDispatch(byOperation) : null;
  }
}

function replayOrConflict(
  existing: AdmittedSegmentDispatchRecord,
  input: ConsumeDispatchInput,
): ConsumeDispatchResult {
  if (
    existing.segmentId === input.segmentId &&
    existing.operationId === input.operationId &&
    existing.sinkProfile === input.sinkProfile &&
    existing.profileGeneration === input.profileGeneration
  ) {
    return { outcome: "replay", dispatch: existing };
  }
  throw new WorkspaceMemoryReplayConflictError(input.operationId);
}

function sameLineage(row: SegmentRow, segment: AdmittedPublicChannelSegment): boolean {
  return sameDecodedLineage(toSegment(row), segment);
}

function sameDecodedLineage(
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

function toSegment(row: SegmentRow): AdmittedPublicChannelSegment {
  const decoded = decodeAdmittedPublicChannelSegment({
    segmentId: row.segmentId,
    sourceMessageIds: row.sourceMessages.map((source) => source.messageId),
    workspace: { workspaceId: row.workspaceId, channelId: row.channelId },
    kind: row.kind,
    conversationKind: row.conversationKind,
    sourcePayloadHash: row.sourcePayloadHash,
    profileGeneration: row.profileGeneration,
    closedAt: row.closedAt.toISOString(),
  });
  if ("code" in decoded) throw new WorkspaceMemoryScopeError();
  return decoded;
}

function toDispatch(row: DispatchRow): AdmittedSegmentDispatchRecord {
  if (
    !(DISPATCH_SINK_PROFILES as readonly string[]).includes(row.sinkProfile) ||
    !(DISPATCH_STATES as readonly string[]).includes(row.state)
  ) {
    throw new WorkspaceMemoryScopeError();
  }
  return {
    workspaceId: row.workspaceId,
    segmentId: row.segmentId,
    operationId: row.operationId,
    sinkProfile: row.sinkProfile as DispatchSinkProfile,
    profileGeneration: row.profileGeneration,
    state: row.state as DispatchState,
    attemptCount: row.attemptCount,
    ...(row.sanitizedError ? { sanitizedError: row.sanitizedError } : {}),
  };
}
