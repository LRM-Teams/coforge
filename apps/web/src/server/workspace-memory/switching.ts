/**
 * F2 composition: non-destructive profile switching observed through one public seam.
 * Consumes frozen P1 profile/reconciler, F1 dispatcher, and the G2 ready gate.
 */
import type { OpenVikingBinding } from "../openviking/contract";
import {
  createDefaultWorkspaceMemoryProfile,
  type DesiredWorkspaceMemoryProfile,
  type ObservedWorkspaceMemoryState,
  type WorkspaceMemoryProfile,
} from "./profile";
import type { AdmissionDispatcher, DispatchOutcome } from "./dispatch";
import type { DetectedPublicChannelSegment } from "./detect-segments";
import type {
  MemoryRuntimeSnapshot,
  ReconcileResult,
  WorkspaceMemoryProfileReconciler,
} from "./reconciler";
import type { SelectDesiredInput, WorkspaceMemoryProfiles } from "./profiles";
import type { SanitizedFailure } from "./errors";

export type MemorySurfaceDecision =
  | { open: true }
  | { open: false; reason: "profile_off" | "not_ready" | "not_causal" };

export type WorkspaceMemoryAccessObservation = {
  workspaceId: string;
  desired: DesiredWorkspaceMemoryProfile;
  observed: ObservedWorkspaceMemoryState;
  generation: number;
  activationCursor: WorkspaceMemoryProfile["activationCursor"];
  reconcileKind: WorkspaceMemoryProfile["reconcileKind"];
  sanitizedFailure: SanitizedFailure | null;
  surfaces: {
    admission: MemorySurfaceDecision;
    openvikingGateway: MemorySurfaceDecision;
    causalRetrieval: MemorySurfaceDecision;
  };
};

export type SwitchingSnapshot = {
  observation: WorkspaceMemoryAccessObservation;
  retained: MemoryRuntimeSnapshot;
};

export type SwitchSelectResult =
  | { ok: true; profile: WorkspaceMemoryProfile; observation: WorkspaceMemoryAccessObservation }
  | { ok: false; failure: SanitizedFailure };

export type SwitchReconcileResult =
  | {
      ok: true;
      profile: WorkspaceMemoryProfile;
      observation: WorkspaceMemoryAccessObservation;
      retained: MemoryRuntimeSnapshot;
      effects: Extract<ReconcileResult, { ok: true }>["effects"];
    }
  | { ok: false; failure: SanitizedFailure };

export type CausalRetrieveResult =
  | { allowed: true; observation: WorkspaceMemoryAccessObservation; result: unknown }
  | { allowed: false; observation: WorkspaceMemoryAccessObservation };

export type WorkspaceMemorySwitching = {
  selectDesired(input: SelectDesiredInput): Promise<SwitchSelectResult>;
  reconcile(workspaceId: string): Promise<SwitchReconcileResult>;
  observe(workspaceId: string): Promise<SwitchingSnapshot>;
  dispatch(input: {
    workspaceId: string;
    detected: DetectedPublicChannelSegment;
  }): Promise<{ outcome: DispatchOutcome; observation: WorkspaceMemoryAccessObservation }>;
  retrieveCausal(input: { workspaceId: string; query: string }): Promise<CausalRetrieveResult>;
};

export type MemoryBindingRef = {
  workspaceId: string;
  generation: number;
};

export function observeWorkspaceMemoryAccess(input: {
  profile: WorkspaceMemoryProfile | null;
  binding?: MemoryBindingRef | OpenVikingBinding | null;
}): WorkspaceMemoryAccessObservation {
  const profile = input.profile ?? createDefaultWorkspaceMemoryProfile("");
  const admission = admissionDecision(profile);
  return {
    workspaceId: profile.workspaceId,
    desired: profile.desired,
    observed: profile.observed,
    generation: profile.generation,
    activationCursor: profile.activationCursor,
    reconcileKind: profile.reconcileKind,
    sanitizedFailure: profile.sanitizedFailure,
    surfaces: {
      admission,
      openvikingGateway: gatewayDecision(profile, input.binding ?? null),
      causalRetrieval:
        profile.desired === "off"
          ? { open: false, reason: "profile_off" }
          : profile.desired !== "causal_openviking"
            ? { open: false, reason: "not_causal" }
            : admission.open
              ? { open: true }
              : { open: false, reason: "not_ready" },
    },
  };
}

function admissionDecision(profile: WorkspaceMemoryProfile): MemorySurfaceDecision {
  if (profile.desired === "off") return { open: false, reason: "profile_off" };
  if (profile.observed !== "ready" && profile.observed !== "degraded") {
    return { open: false, reason: "not_ready" };
  }
  return { open: true };
}

function gatewayDecision(
  profile: WorkspaceMemoryProfile,
  binding: MemoryBindingRef | OpenVikingBinding | null,
): MemorySurfaceDecision {
  if (profile.desired === "off") return { open: false, reason: "profile_off" };
  if (profile.observed !== "ready") return { open: false, reason: "not_ready" };
  if (!binding) return { open: false, reason: "not_ready" };
  if (binding.workspaceId !== profile.workspaceId) return { open: false, reason: "not_ready" };
  if (binding.generation !== profile.generation) return { open: false, reason: "not_ready" };
  return { open: true };
}

export function createWorkspaceMemorySwitching(deps: {
  profiles: WorkspaceMemoryProfiles;
  reconciler: WorkspaceMemoryProfileReconciler;
  dispatcher: AdmissionDispatcher;
  getBinding: (workspaceId: string) => Promise<MemoryBindingRef | OpenVikingBinding | null>;
  snapshotRuntimes: (workspaceId: string) => MemoryRuntimeSnapshot | Promise<MemoryRuntimeSnapshot>;
  retrieveCausal?: (input: { workspaceId: string; query: string }) => Promise<unknown>;
}): WorkspaceMemorySwitching {
  async function observeProfile(workspaceId: string): Promise<WorkspaceMemoryAccessObservation> {
    const profile = await deps.profiles.get(workspaceId);
    const binding = await deps.getBinding(workspaceId);
    return observeWorkspaceMemoryAccess({ profile, binding });
  }

  return {
    async selectDesired(input) {
      const selected = await deps.profiles.selectDesired(input);
      if (!selected.ok) return selected;
      return {
        ok: true,
        profile: selected.profile,
        observation: await observeProfile(input.workspaceId),
      };
    },
    async reconcile(workspaceId) {
      const result = await deps.reconciler.reconcile(workspaceId);
      if (!result.ok) return result;
      return {
        ok: true,
        profile: result.profile,
        effects: result.effects,
        observation: await observeProfile(workspaceId),
        retained: await deps.snapshotRuntimes(workspaceId),
      };
    },
    async observe(workspaceId) {
      return {
        observation: await observeProfile(workspaceId),
        retained: await deps.snapshotRuntimes(workspaceId),
      };
    },
    async dispatch(input) {
      const profile = await deps.profiles.get(input.workspaceId);
      const observation = await observeProfile(input.workspaceId);
      const outcome = await deps.dispatcher.dispatch({ profile, detected: input.detected });
      return { outcome, observation };
    },
    async retrieveCausal(input) {
      const observation = await observeProfile(input.workspaceId);
      if (!observation.surfaces.causalRetrieval.open) {
        return { allowed: false, observation };
      }
      const result = await deps.retrieveCausal?.(input);
      return { allowed: true, observation, result };
    },
  };
}
