import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  UPGRADE_OPERATION_HISTORY,
  type BindingStore,
  type ManagedBinding,
} from "./machine-supervisor";

/** Coordinator-owned registry. File and directory sync bracket atomic replacement. */
export class FileBindingStore implements BindingStore {
  readonly #path: string;
  constructor(
    private readonly directory: string,
    private readonly expectedServerUrl?: string,
  ) {
    this.#path = join(directory, "bindings.json");
  }
  async load(): Promise<ManagedBinding[]> {
    let value: unknown;
    try {
      value = await Bun.file(this.#path).json();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    validateBindings(value);
    this.#assertEnvironment(value);
    return value.map(migrateLegacyUpgradeRequests);
  }
  async save(bindings: ManagedBinding[]): Promise<void> {
    validateBindings(bindings);
    this.#assertEnvironment(bindings);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    // FileHandle is required for sync; Bun.write alone does not expose this durability boundary.
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(bindings) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.#path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #assertEnvironment(bindings: ManagedBinding[]) {
    if (!this.expectedServerUrl) return;
    for (const binding of bindings) {
      if (!binding.serverHttpUrl) throw new Error("Persisted binding does not identify its server");
      if (new URL(binding.serverHttpUrl).origin !== new URL(this.expectedServerUrl).origin)
        throw new Error("Binding server does not match this daemon build");
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function validateBindings(value: unknown): asserts value is ManagedBinding[] {
  if (!Array.isArray(value)) throw new Error("invalid binding registry");
  const ids = new Set<string>();
  for (const binding of value) {
    if (
      !record(binding) ||
      !text(binding.workspaceId) ||
      !text(binding.computerId) ||
      !text(binding.workspaceRoot) ||
      typeof binding.enabled !== "boolean" ||
      ids.has(binding.workspaceId)
    )
      throw new Error("invalid binding registry");
    ids.add(binding.workspaceId);
    if (binding.restart !== undefined) {
      const pending = binding.restart;
      if (
        !binding.enabled ||
        !record(pending) ||
        !text(pending.requestId) ||
        !["stopping", "starting"].includes(String(pending.phase)) ||
        !(pending.previousInstanceId === null || text(pending.previousInstanceId))
      )
        throw new Error("invalid binding registry restart");
    }
    if (binding.restartResults !== undefined) {
      if (!Array.isArray(binding.restartResults) || binding.restartResults.length > 128)
        throw new Error("invalid binding registry results");
      const requests = new Set<string>();
      for (const result of binding.restartResults) {
        if (
          !record(result) ||
          !text(result.requestId) ||
          requests.has(result.requestId) ||
          !(
            result.status === "cancelled" ||
            (result.status === "completed" && text(result.instanceId))
          )
        )
          throw new Error("invalid binding registry result");
        requests.add(result.requestId);
      }
      if (record(binding.restart) && requests.has(String(binding.restart.requestId)))
        throw new Error("invalid binding registry conflicting restart");
    }
    if (binding.upgradeRequestIds !== undefined) {
      if (
        !Array.isArray(binding.upgradeRequestIds) ||
        binding.upgradeRequestIds.length > 128 ||
        binding.upgradeRequestIds.some((requestId) => !text(requestId)) ||
        new Set(binding.upgradeRequestIds).size !== binding.upgradeRequestIds.length
      )
        throw new Error("invalid binding registry upgrade request IDs");
    }
    if (binding.upgradeRequests !== undefined) {
      if (!Array.isArray(binding.upgradeRequests) || binding.upgradeRequests.length > 128)
        throw new Error("invalid binding registry upgrades");
      const requests = new Set<string>();
      for (const request of binding.upgradeRequests) {
        if (
          !record(request) ||
          !text(request.requestId) ||
          !text(request.expectedVersion) ||
          requests.has(request.requestId)
        )
          throw new Error("invalid binding registry upgrade request");
        requests.add(request.requestId);
      }
    }
    validateUpgradeOperations(binding.upgradeOperations);
  }
}

const UPGRADE_OPERATION_STATES = ["pending", "succeeded", "failed", "acknowledged"];

/** One operation at a time may be pending, and every terminal state carries its receipt. */
function validateUpgradeOperations(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > UPGRADE_OPERATION_HISTORY)
    throw new Error("invalid binding registry upgrade operations");
  const seen = new Set<string>();
  let pending = 0;
  for (const operation of value) {
    if (
      !record(operation) ||
      !text(operation.requestId) ||
      !text(operation.expectedVersion) ||
      !UPGRADE_OPERATION_STATES.includes(String(operation.state)) ||
      seen.has(operation.requestId)
    )
      throw new Error("invalid binding registry upgrade operation");
    seen.add(operation.requestId);
    if (operation.state === "pending") pending += 1;
    const terminal = operation.terminal;
    if (operation.state === "pending") {
      if (terminal !== undefined) throw new Error("invalid binding registry upgrade operation");
    } else if (operation.state !== "acknowledged" || terminal !== undefined) {
      if (
        !record(terminal) ||
        !Number.isSafeInteger(terminal.at) ||
        (terminal.version !== undefined && !text(terminal.version)) ||
        (terminal.error !== undefined && !text(terminal.error))
      )
        throw new Error("invalid binding registry upgrade operation");
    }
  }
  if (pending > 1) throw new Error("invalid binding registry upgrade operation overlap");
}

/**
 * Reopens the pre-receipt `upgradeRequests` dedupe list as pending operations. Those entries were
 * never cleared, so a machine can carry requests for versions it finished long ago; they become
 * ordinary pending operations that the receipt sweep resolves or that expire with the record cap.
 */
function migrateLegacyUpgradeRequests(binding: ManagedBinding): ManagedBinding {
  if (!binding.upgradeRequests?.length) return binding;
  const { upgradeRequests, ...rest } = binding;
  const existing = new Set((binding.upgradeOperations ?? []).map((entry) => entry.requestId));
  return {
    ...rest,
    upgradeOperations: [
      ...(binding.upgradeOperations ?? []),
      ...upgradeRequests
        .filter((request) => !existing.has(request.requestId))
        .map((request) => ({ ...request, state: "pending" as const })),
    ].slice(-UPGRADE_OPERATION_HISTORY),
  };
}
