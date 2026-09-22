import { sanitizeWorkspaceMemoryFailure, type SanitizedFailure } from "./errors";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
  type DesiredWorkspaceMemoryProfile,
  type ProfileCommandResult,
  type WorkspaceMemoryProfile,
} from "./profile";
import { saveProfileTransition, type WorkspaceMemoryProfileStore } from "./stores";

export const MEMORY_RUNTIME_KINDS = ["openviking", "causal_tenant"] as const;
export type MemoryRuntimeKind = (typeof MEMORY_RUNTIME_KINDS)[number];
export type MemoryRuntimeHealth = "healthy" | "degraded";

export type MemoryRuntimeReceipt = {
  workspaceId: string;
  generation: number;
  kind: MemoryRuntimeKind;
  resourceId: string;
};

export type MemoryRuntimeSnapshot = {
  openviking: MemoryRuntimeReceipt | null;
  causalTenant: MemoryRuntimeReceipt | null;
};

export type MemoryRuntimeProvisioner = {
  ensure(input: {
    workspaceId: string;
    generation: number;
    kind: MemoryRuntimeKind;
  }): Promise<MemoryRuntimeReceipt>;
  inspectHealth(input: { workspaceId: string; generation: number }): Promise<MemoryRuntimeHealth>;
};

export type ReconcileEffects = {
  ensured: readonly MemoryRuntimeKind[];
  processing: "active" | "stopped";
};

export type ReconcileResult =
  | { ok: true; profile: WorkspaceMemoryProfile; effects: ReconcileEffects }
  | { ok: false; failure: SanitizedFailure };

export type WorkspaceMemoryProfileReconciler = {
  reconcile(workspaceId: string): Promise<ReconcileResult>;
};

export function createWorkspaceMemoryProfileReconciler(deps: {
  store: WorkspaceMemoryProfileStore;
  provisioner: MemoryRuntimeProvisioner;
}): WorkspaceMemoryProfileReconciler {
  return {
    async reconcile(workspaceId) {
      const previous =
        (await deps.store.get(workspaceId)) ?? createDefaultWorkspaceMemoryProfile(workspaceId);
      const result = await reconcile(previous, deps.provisioner);
      if (!result.ok || !profileChanged(previous, result.profile)) {
        return result;
      }
      const saved = await saveProfileTransition(deps.store, previous, result.profile);
      return saved === "saved" ? result : stale();
    },
  };
}

export async function reconcile(
  state: WorkspaceMemoryProfile,
  provisioner: MemoryRuntimeProvisioner,
): Promise<ReconcileResult> {
  if (state.observed === "error") {
    const retried = applyWorkspaceMemoryCommand(state, {
      type: "retry",
      generation: state.generation,
    });
    if (!retried.ok) return retried;
    return settle(retried.profile, provisioner);
  }
  if (state.observed === "provisioning" || state.observed === "switching") {
    return settle(state, provisioner);
  }
  if (state.desired === "off") {
    return {
      ok: true,
      profile: state,
      effects: { ensured: [], processing: "stopped" },
    };
  }
  if (state.observed === "ready" || state.observed === "degraded") {
    return recoverHealth(state, provisioner);
  }
  return { ok: false, failure: sanitizeWorkspaceMemoryFailure("invalid_transition") };
}

async function settle(
  state: WorkspaceMemoryProfile,
  provisioner: MemoryRuntimeProvisioner,
): Promise<ReconcileResult> {
  const ensured: MemoryRuntimeKind[] = [];
  try {
    for (const kind of neededKinds(state.desired)) {
      const receipt = await provisioner.ensure({
        workspaceId: state.workspaceId,
        generation: state.generation,
        kind,
      });
      if (receipt.workspaceId !== state.workspaceId || receipt.generation !== state.generation) {
        return stale();
      }
      ensured.push(kind);
    }
  } catch (error) {
    const failure = sanitizeWorkspaceMemoryFailure(
      "provisioning_failed",
      error instanceof Error ? error.message : String(error),
    );
    const errored = applyWorkspaceMemoryCommand(state, {
      type: "observe_error",
      generation: state.generation,
      failure,
    });
    if (!errored.ok) return errored;
    return {
      ok: true,
      profile: errored.profile,
      effects: { ensured, processing: state.desired === "off" ? "stopped" : "active" },
    };
  }

  const ready = applyWorkspaceMemoryCommand(state, {
    type: "observe_ready",
    generation: state.generation,
  });
  if (!ready.ok) return ready;
  return {
    ok: true,
    profile: ready.profile,
    effects: {
      ensured,
      processing: state.desired === "off" ? "stopped" : "active",
    },
  };
}

async function recoverHealth(
  state: WorkspaceMemoryProfile,
  provisioner: MemoryRuntimeProvisioner,
): Promise<ReconcileResult> {
  let health: MemoryRuntimeHealth;
  try {
    health = await provisioner.inspectHealth({
      workspaceId: state.workspaceId,
      generation: state.generation,
    });
  } catch {
    health = "degraded";
  }

  const next: ProfileCommandResult =
    health === "degraded"
      ? applyWorkspaceMemoryCommand(state, {
          type: "observe_degraded",
          generation: state.generation,
        })
      : applyWorkspaceMemoryCommand(state, {
          type: "observe_ready",
          generation: state.generation,
        });
  if (!next.ok) return next;
  return {
    ok: true,
    profile: next.profile,
    effects: { ensured: [], processing: "active" },
  };
}

function neededKinds(desired: DesiredWorkspaceMemoryProfile): readonly MemoryRuntimeKind[] {
  switch (desired) {
    case "openviking":
      return ["openviking"];
    case "causal_openviking":
      return ["openviking", "causal_tenant"];
    case "off":
      return [];
  }
}

function profileChanged(previous: WorkspaceMemoryProfile, next: WorkspaceMemoryProfile): boolean {
  return (
    previous.desired !== next.desired ||
    previous.observed !== next.observed ||
    previous.generation !== next.generation ||
    previous.sanitizedFailure?.code !== next.sanitizedFailure?.code
  );
}

function stale(): { ok: false; failure: SanitizedFailure } {
  return { ok: false, failure: sanitizeWorkspaceMemoryFailure("stale_generation") };
}

export type FakeMemoryRuntimeProvisioner = MemoryRuntimeProvisioner & {
  readonly deleted: readonly MemoryRuntimeKind[];
  snapshot(workspaceId: string): MemoryRuntimeSnapshot;
  failNext(kind: MemoryRuntimeKind, raw?: string): void;
  setHealth(status: MemoryRuntimeHealth): void;
  holdEnsure(): { release(): void };
};

export function createFakeMemoryRuntimeProvisioner(): FakeMemoryRuntimeProvisioner {
  const openviking = new Map<string, MemoryRuntimeReceipt>();
  const causalTenants = new Map<string, MemoryRuntimeReceipt>();
  const pendingFailures = new Map<MemoryRuntimeKind, string>();
  const deleted: MemoryRuntimeKind[] = [];
  let health: MemoryRuntimeHealth = "healthy";
  let barrier = Promise.resolve();

  return {
    deleted,
    failNext(kind, raw = "memory runtime provisioning failed") {
      pendingFailures.set(kind, raw);
    },
    setHealth(status) {
      health = status;
    },
    holdEnsure() {
      let release = () => {};
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release };
    },
    snapshot(workspaceId) {
      return {
        openviking: cloneReceipt(openviking.get(workspaceId)),
        causalTenant: cloneReceipt(causalTenants.get(workspaceId)),
      };
    },
    async inspectHealth() {
      return health;
    },
    async ensure({ workspaceId, generation, kind }) {
      await barrier;
      const raw = pendingFailures.get(kind);
      if (raw !== undefined) {
        pendingFailures.delete(kind);
        throw new Error(raw);
      }
      const records = kind === "openviking" ? openviking : causalTenants;
      const existing = records.get(workspaceId);
      if (existing) {
        if (generation < existing.generation) return structuredClone(existing);
        const updated = { ...existing, generation };
        records.set(workspaceId, updated);
        return structuredClone(updated);
      }
      const receipt: MemoryRuntimeReceipt = {
        workspaceId,
        generation,
        kind,
        resourceId: kind === "openviking" ? `acct-${workspaceId}` : `tenant-${workspaceId}`,
      };
      records.set(workspaceId, receipt);
      return structuredClone(receipt);
    },
  };
}

function cloneReceipt(receipt: MemoryRuntimeReceipt | undefined): MemoryRuntimeReceipt | null {
  return receipt ? structuredClone(receipt) : null;
}
