import type { PrismaClient } from "../../../../generated/client";
import {
  parseDesiredWorkspaceMemoryProfile,
  parseObservedWorkspaceMemoryState,
  type ActivationCursor,
  type ReconcileKind,
  type WorkspaceMemoryProfile,
} from "../../workspace-memory/profile";
import {
  sanitizeWorkspaceMemoryFailure,
  type SanitizedFailure,
  type WorkspaceMemoryFailureCode,
  WORKSPACE_MEMORY_FAILURE_CODES,
} from "../../workspace-memory/errors";
import type { WorkspaceMemoryProfileStore } from "../../workspace-memory/stores";
import {
  isUniqueConstraintError,
  WorkspaceMemoryScopeError,
} from "./workspace-memory-errors.server";

type ProfileRow = {
  workspaceId: string;
  desired: string;
  observed: string;
  generation: number;
  activationCursorKind: string | null;
  activationOccurredAt: Date | null;
  activationMessageId: string | null;
  reconcileKind: string | null;
  sanitizedFailureCode: string | null;
  sanitizedFailureMessage: string | null;
};

export class PrismaWorkspaceMemoryProfileStore implements WorkspaceMemoryProfileStore {
  constructor(private readonly db: PrismaClient) {}

  async get(workspaceId: string): Promise<WorkspaceMemoryProfile | null> {
    const row = await this.db.workspaceMemoryProfile.findUnique({ where: { workspaceId } });
    return row ? toProfile(row) : null;
  }

  async compareAndSet(input: {
    workspaceId: string;
    expectedGeneration: number;
    profile: WorkspaceMemoryProfile;
  }): Promise<"saved" | "stale_generation"> {
    if (input.profile.workspaceId !== input.workspaceId) throw new WorkspaceMemoryScopeError();
    const columns = toColumns(input.profile);
    try {
      return await this.db.$transaction(async (tx) => {
        const current = await tx.workspaceMemoryProfile.findUnique({
          where: { workspaceId: input.workspaceId },
        });
        const currentGeneration = current?.generation ?? 0;
        if (
          currentGeneration !== input.expectedGeneration ||
          input.profile.generation < currentGeneration
        ) {
          return "stale_generation";
        }
        if (!current) {
          await tx.workspaceMemoryProfile.create({ data: columns });
          return "saved";
        }
        const updated = await tx.workspaceMemoryProfile.updateMany({
          where: { workspaceId: input.workspaceId, generation: input.expectedGeneration },
          data: {
            desired: columns.desired,
            observed: columns.observed,
            generation: columns.generation,
            activationCursorKind: columns.activationCursorKind,
            activationOccurredAt: columns.activationOccurredAt,
            activationMessageId: columns.activationMessageId,
            reconcileKind: columns.reconcileKind,
            sanitizedFailureCode: columns.sanitizedFailureCode,
            sanitizedFailureMessage: columns.sanitizedFailureMessage,
          },
        });
        return updated.count === 1 ? "saved" : "stale_generation";
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return "stale_generation";
      throw error;
    }
  }
}

function toColumns(profile: WorkspaceMemoryProfile) {
  return {
    workspaceId: profile.workspaceId,
    desired: profile.desired,
    observed: profile.observed,
    generation: profile.generation,
    activationCursorKind: profile.activationCursor?.kind ?? null,
    activationOccurredAt: profile.activationCursor
      ? new Date(profile.activationCursor.occurredAt)
      : null,
    activationMessageId:
      profile.activationCursor?.kind === "message" ? profile.activationCursor.messageId : null,
    reconcileKind: profile.reconcileKind,
    sanitizedFailureCode: profile.sanitizedFailure?.code ?? null,
    sanitizedFailureMessage: profile.sanitizedFailure?.message ?? null,
  };
}

function toProfile(row: ProfileRow): WorkspaceMemoryProfile {
  const desired = parseDesiredWorkspaceMemoryProfile(row.desired);
  const observed = parseObservedWorkspaceMemoryState(row.observed);
  if (!desired || !observed) throw new WorkspaceMemoryScopeError();
  return {
    workspaceId: row.workspaceId,
    desired,
    observed,
    generation: row.generation,
    activationCursor: toCursor(row),
    reconcileKind: parseReconcileKind(row.reconcileKind),
    sanitizedFailure: toFailure(row.sanitizedFailureCode, row.sanitizedFailureMessage),
  };
}

function toCursor(row: ProfileRow): ActivationCursor | null {
  if (row.activationCursorKind === "time" && row.activationOccurredAt) {
    return { kind: "time", occurredAt: row.activationOccurredAt.toISOString() };
  }
  if (
    row.activationCursorKind === "message" &&
    row.activationOccurredAt &&
    row.activationMessageId
  ) {
    return {
      kind: "message",
      occurredAt: row.activationOccurredAt.toISOString(),
      messageId: row.activationMessageId,
    };
  }
  return null;
}

function parseReconcileKind(value: string | null): ReconcileKind | null {
  return value === "provision" || value === "switch" ? value : null;
}

function toFailure(code: string | null, message: string | null): SanitizedFailure | null {
  if (!code || !message) return null;
  if (!(WORKSPACE_MEMORY_FAILURE_CODES as readonly string[]).includes(code)) return null;
  return sanitizeWorkspaceMemoryFailure(code as WorkspaceMemoryFailureCode);
}
