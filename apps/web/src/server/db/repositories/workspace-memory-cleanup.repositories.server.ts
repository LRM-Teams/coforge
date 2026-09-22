import type { PrismaClient } from "../../../../generated/client";
import {
  isUniqueConstraintError,
  WorkspaceMemoryScopeError,
} from "./workspace-memory-errors.server";

export const CLEANUP_TARGETS = [
  "causal_tenant",
  "openviking_account",
  "managed_causal_projection",
  "pending_projection_work",
  "openviking_binding",
] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export const CLEANUP_STATES = ["pending", "leased", "retryable_failure", "settled"] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

export type WorkspaceMemoryCleanupWork = {
  workspaceId: string;
  operationId: string;
  target: CleanupTarget;
  state: CleanupState;
  attemptCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  sanitizedError?: string;
};

export type WorkspaceMemoryCleanupStore = {
  enqueue(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
  }): Promise<WorkspaceMemoryCleanupWork>;
  get(
    workspaceId: string,
    operationId: string,
    target: CleanupTarget,
  ): Promise<WorkspaceMemoryCleanupWork | null>;
  lease(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
    now: Date;
    ttlMs: number;
  }): Promise<WorkspaceMemoryCleanupWork | null>;
  failRetryable(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
    sanitizedError: string;
  }): Promise<WorkspaceMemoryCleanupWork>;
  settle(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
  }): Promise<WorkspaceMemoryCleanupWork>;
};

type CleanupRow = {
  workspaceId: string;
  operationId: string;
  target: string;
  state: string;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  sanitizedError: string | null;
};

export class PrismaWorkspaceMemoryCleanupStore implements WorkspaceMemoryCleanupStore {
  constructor(private readonly db: PrismaClient) {}

  async enqueue(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
  }): Promise<WorkspaceMemoryCleanupWork> {
    assertTarget(input.target);
    const existing = await this.get(input.workspaceId, input.operationId, input.target);
    if (existing) return existing;
    try {
      const row = await this.db.workspaceMemoryCleanupWork.create({
        data: {
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          target: input.target,
          state: "pending",
        },
      });
      return toWork(row);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const replayed = await this.get(input.workspaceId, input.operationId, input.target);
      if (!replayed) throw new WorkspaceMemoryScopeError();
      return replayed;
    }
  }

  async get(
    workspaceId: string,
    operationId: string,
    target: CleanupTarget,
  ): Promise<WorkspaceMemoryCleanupWork | null> {
    const row = await this.db.workspaceMemoryCleanupWork.findUnique({
      where: { workspaceId_operationId_target: { workspaceId, operationId, target } },
    });
    return row ? toWork(row) : null;
  }

  async lease(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
    now: Date;
    ttlMs: number;
  }): Promise<WorkspaceMemoryCleanupWork | null> {
    assertTarget(input.target);
    const leaseExpiresAt = new Date(input.now.getTime() + input.ttlMs);
    const updated = await this.db.workspaceMemoryCleanupWork.updateMany({
      where: {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        target: input.target,
        OR: [
          { state: { in: ["pending", "retryable_failure"] } },
          { state: "leased", leaseExpiresAt: { lte: input.now } },
        ],
      },
      data: {
        state: "leased",
        leaseOwner: input.owner,
        leaseExpiresAt,
        sanitizedError: null,
        attemptCount: { increment: 1 },
      },
    });
    if (updated.count !== 1) return null;
    return this.get(input.workspaceId, input.operationId, input.target);
  }

  async failRetryable(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
    sanitizedError: string;
  }): Promise<WorkspaceMemoryCleanupWork> {
    const updated = await this.db.workspaceMemoryCleanupWork.updateMany({
      where: {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        target: input.target,
        state: "leased",
        leaseOwner: input.owner,
      },
      data: {
        state: "retryable_failure",
        leaseOwner: null,
        leaseExpiresAt: null,
        sanitizedError: input.sanitizedError,
      },
    });
    if (updated.count !== 1) throw new WorkspaceMemoryScopeError();
    const row = await this.get(input.workspaceId, input.operationId, input.target);
    if (!row) throw new WorkspaceMemoryScopeError();
    return row;
  }

  async settle(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
  }): Promise<WorkspaceMemoryCleanupWork> {
    const updated = await this.db.workspaceMemoryCleanupWork.updateMany({
      where: {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        target: input.target,
        state: "leased",
        leaseOwner: input.owner,
      },
      data: {
        state: "settled",
        leaseOwner: null,
        leaseExpiresAt: null,
        sanitizedError: null,
      },
    });
    if (updated.count !== 1) throw new WorkspaceMemoryScopeError();
    const row = await this.get(input.workspaceId, input.operationId, input.target);
    if (!row) throw new WorkspaceMemoryScopeError();
    return row;
  }
}

function assertTarget(target: string): asserts target is CleanupTarget {
  if (!(CLEANUP_TARGETS as readonly string[]).includes(target)) {
    throw new WorkspaceMemoryScopeError();
  }
}

function toWork(row: CleanupRow): WorkspaceMemoryCleanupWork {
  if (
    !(CLEANUP_TARGETS as readonly string[]).includes(row.target) ||
    !(CLEANUP_STATES as readonly string[]).includes(row.state)
  ) {
    throw new WorkspaceMemoryScopeError();
  }
  return {
    workspaceId: row.workspaceId,
    operationId: row.operationId,
    target: row.target as CleanupTarget,
    state: row.state as CleanupState,
    attemptCount: row.attemptCount,
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt.toISOString() } : {}),
    ...(row.sanitizedError ? { sanitizedError: row.sanitizedError } : {}),
  };
}
