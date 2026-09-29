import {
  CLEANUP_TARGETS,
  type CleanupTarget,
  type WorkspaceMemoryCleanupStore,
  type WorkspaceMemoryCleanupWork,
} from "../db/repositories/workspace-memory-cleanup.repositories.server";
import { WorkspaceMemoryScopeError } from "../db/repositories/workspace-memory-errors.server";

export const WORKSPACE_DELETION_CLEANUP_TARGETS = CLEANUP_TARGETS;

export type CleanupRemoteResult = { ok: true } | { ok: false; sanitizedError: string };

export type WorkspaceMemoryCleanupRemotes = {
  deleteOpenVikingAccount(input: {
    workspaceId: string;
    operationId: string;
    owner: string;
  }): Promise<CleanupRemoteResult>;
  removeBinding(input: { workspaceId: string; operationId: string }): Promise<CleanupRemoteResult>;
};

export type WorkspaceMemoryCleanupRun =
  | { status: "completed"; works: readonly WorkspaceMemoryCleanupWork[] }
  | { status: "retryable_failure"; failedTarget: CleanupTarget; work: WorkspaceMemoryCleanupWork }
  | { status: "not_leased"; target: CleanupTarget; work: WorkspaceMemoryCleanupWork }
  | { status: "not_enqueued" };

export type WorkspaceMemoryCleanup = {
  enqueueWorkspaceDeletion(input: {
    workspaceId: string;
    operationId: string;
  }): Promise<readonly WorkspaceMemoryCleanupWork[]>;
  run(input: {
    workspaceId: string;
    operationId: string;
    owner: string;
    now: Date;
    ttlMs: number;
  }): Promise<WorkspaceMemoryCleanupRun>;
  lease(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
    now: Date;
    ttlMs: number;
  }): Promise<WorkspaceMemoryCleanupWork | null>;
  settle(input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
  }): Promise<WorkspaceMemoryCleanupWork>;
};

const SANITIZED_REMOTE_ERRORS: Record<CleanupTarget, string> = {
  openviking_account: "openviking account delete failed",
  openviking_binding: "openviking binding delete failed",
};

export function createWorkspaceMemoryCleanup(deps: {
  store: WorkspaceMemoryCleanupStore;
  remotes: WorkspaceMemoryCleanupRemotes;
}): WorkspaceMemoryCleanup {
  return {
    async enqueueWorkspaceDeletion(input) {
      const works: WorkspaceMemoryCleanupWork[] = [];
      for (const target of CLEANUP_TARGETS) {
        works.push(await deps.store.enqueue({ ...input, target }));
      }
      return works;
    },
    async run(input) {
      for (const target of CLEANUP_TARGETS) {
        const work = await deps.store.get(input.workspaceId, input.operationId, target);
        if (!work) return { status: "not_enqueued" };
      }

      const works: WorkspaceMemoryCleanupWork[] = [];
      for (const target of CLEANUP_TARGETS) {
        const current = await deps.store.get(input.workspaceId, input.operationId, target);
        if (!current) return { status: "not_enqueued" };
        if (current.state === "settled") {
          works.push(current);
          continue;
        }
        const leased = await deps.store.lease({
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          target,
          owner: input.owner,
          now: input.now,
          ttlMs: input.ttlMs,
        });
        if (!leased) return { status: "not_leased", target, work: current };
        const remote = await invokeRemote(deps.remotes, target, {
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          owner: input.owner,
        });
        if (!remote.ok) {
          const failed = await deps.store.failRetryable({
            workspaceId: input.workspaceId,
            operationId: input.operationId,
            target,
            owner: input.owner,
            sanitizedError: SANITIZED_REMOTE_ERRORS[target],
          });
          return { status: "retryable_failure", failedTarget: target, work: failed };
        }
        works.push(
          await settleIdempotent(deps.store, {
            workspaceId: input.workspaceId,
            operationId: input.operationId,
            target,
            owner: input.owner,
          }),
        );
      }
      return { status: "completed", works };
    },
    lease(input) {
      return deps.store.lease(input);
    },
    settle(input) {
      return settleIdempotent(deps.store, input);
    },
  };
}

async function settleIdempotent(
  store: WorkspaceMemoryCleanupStore,
  input: {
    workspaceId: string;
    operationId: string;
    target: CleanupTarget;
    owner: string;
  },
): Promise<WorkspaceMemoryCleanupWork> {
  const current = await store.get(input.workspaceId, input.operationId, input.target);
  if (!current) throw new WorkspaceMemoryScopeError();
  if (current.state === "settled") return current;
  return store.settle(input);
}

async function invokeRemote(
  remotes: WorkspaceMemoryCleanupRemotes,
  target: CleanupTarget,
  input: { workspaceId: string; operationId: string; owner: string },
): Promise<CleanupRemoteResult> {
  try {
    switch (target) {
      case "openviking_account":
        return await remotes.deleteOpenVikingAccount(input);
      case "openviking_binding":
        return await remotes.removeBinding(input);
    }
  } catch {
    return { ok: false, sanitizedError: SANITIZED_REMOTE_ERRORS[target] };
  }
}

export type FakeWorkspaceMemoryCleanupRemotes = WorkspaceMemoryCleanupRemotes & {
  readonly calls: readonly CleanupTarget[];
  fail(target: CleanupTarget, raw?: string): void;
};

export function createFakeWorkspaceMemoryCleanupRemotes(): FakeWorkspaceMemoryCleanupRemotes {
  const calls: CleanupTarget[] = [];
  const failures = new Map<CleanupTarget, string>();
  const invoke = async (target: CleanupTarget): Promise<CleanupRemoteResult> => {
    calls.push(target);
    const raw = failures.get(target);
    if (raw !== undefined) {
      failures.delete(target);
      void raw;
      return { ok: false, sanitizedError: SANITIZED_REMOTE_ERRORS[target] };
    }
    return { ok: true };
  };
  return {
    calls,
    fail(target, raw = SANITIZED_REMOTE_ERRORS[target]) {
      failures.set(target, raw);
    },
    deleteOpenVikingAccount: () => invoke("openviking_account"),
    removeBinding: () => invoke("openviking_binding"),
  };
}

type MemoryCleanupRow = WorkspaceMemoryCleanupWork & {
  leaseExpiresAtMs?: number;
};

export function createInMemoryWorkspaceMemoryCleanupStore(): WorkspaceMemoryCleanupStore {
  const rows = new Map<string, MemoryCleanupRow>();
  const keyOf = (workspaceId: string, operationId: string, target: CleanupTarget) =>
    `${workspaceId}\0${operationId}\0${target}`;
  const read = (workspaceId: string, operationId: string, target: CleanupTarget) => {
    const row = rows.get(keyOf(workspaceId, operationId, target));
    return row ? cloneWork(row) : null;
  };
  return {
    async enqueue(input) {
      const existing = read(input.workspaceId, input.operationId, input.target);
      if (existing) return existing;
      const created: MemoryCleanupRow = {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        target: input.target,
        state: "pending",
        attemptCount: 0,
      };
      rows.set(keyOf(input.workspaceId, input.operationId, input.target), created);
      return cloneWork(created);
    },
    async get(workspaceId, operationId, target) {
      return read(workspaceId, operationId, target);
    },
    async lease(input) {
      const key = keyOf(input.workspaceId, input.operationId, input.target);
      const row = rows.get(key);
      if (!row) return null;
      const expired =
        row.state === "leased" &&
        row.leaseExpiresAtMs !== undefined &&
        row.leaseExpiresAtMs <= input.now.getTime();
      if (row.state !== "pending" && row.state !== "retryable_failure" && !expired) return null;
      row.state = "leased";
      row.leaseOwner = input.owner;
      row.leaseExpiresAtMs = input.now.getTime() + input.ttlMs;
      row.leaseExpiresAt = new Date(row.leaseExpiresAtMs).toISOString();
      row.sanitizedError = undefined;
      row.attemptCount += 1;
      return cloneWork(row);
    },
    async failRetryable(input) {
      const row = rows.get(keyOf(input.workspaceId, input.operationId, input.target));
      if (!row || row.state !== "leased" || row.leaseOwner !== input.owner) {
        throw new WorkspaceMemoryScopeError();
      }
      row.state = "retryable_failure";
      row.leaseOwner = undefined;
      row.leaseExpiresAt = undefined;
      row.leaseExpiresAtMs = undefined;
      row.sanitizedError = input.sanitizedError;
      return cloneWork(row);
    },
    async settle(input) {
      const row = rows.get(keyOf(input.workspaceId, input.operationId, input.target));
      if (!row || row.state !== "leased" || row.leaseOwner !== input.owner) {
        throw new WorkspaceMemoryScopeError();
      }
      row.state = "settled";
      row.leaseOwner = undefined;
      row.leaseExpiresAt = undefined;
      row.leaseExpiresAtMs = undefined;
      row.sanitizedError = undefined;
      return cloneWork(row);
    },
  };
}

function cloneWork(row: MemoryCleanupRow): WorkspaceMemoryCleanupWork {
  return {
    workspaceId: row.workspaceId,
    operationId: row.operationId,
    target: row.target,
    state: row.state,
    attemptCount: row.attemptCount,
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.sanitizedError ? { sanitizedError: row.sanitizedError } : {}),
  };
}
