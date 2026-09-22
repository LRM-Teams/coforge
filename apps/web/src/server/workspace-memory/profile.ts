import { sanitizeWorkspaceMemoryFailure, type SanitizedFailure } from "./errors";

export const DESIRED_WORKSPACE_MEMORY_PROFILES = [
  "off",
  "openviking",
  "causal_openviking",
] as const;
export type DesiredWorkspaceMemoryProfile = (typeof DESIRED_WORKSPACE_MEMORY_PROFILES)[number];

export const OBSERVED_WORKSPACE_MEMORY_STATES = [
  "provisioning",
  "ready",
  "degraded",
  "switching",
  "error",
] as const;
export type ObservedWorkspaceMemoryState = (typeof OBSERVED_WORKSPACE_MEMORY_STATES)[number];

export type ActivationCursor =
  | { kind: "time"; occurredAt: string }
  | { kind: "message"; occurredAt: string; messageId: string };

export type ReconcileKind = "provision" | "switch";

export type WorkspaceMemoryProfile = {
  workspaceId: string;
  desired: DesiredWorkspaceMemoryProfile;
  observed: ObservedWorkspaceMemoryState;
  generation: number;
  activationCursor: ActivationCursor | null;
  reconcileKind: ReconcileKind | null;
  sanitizedFailure: SanitizedFailure | null;
};

export type WorkspaceMemoryCommand =
  | {
      type: "select_desired";
      desired: DesiredWorkspaceMemoryProfile;
      at: Date;
      afterMessageId?: string;
    }
  | { type: "observe_ready"; generation: number }
  | { type: "observe_degraded"; generation: number }
  | { type: "observe_error"; generation: number; failure: SanitizedFailure }
  | { type: "retry"; generation: number };

export type ProfileCommandResult =
  | { ok: true; profile: WorkspaceMemoryProfile }
  | { ok: false; failure: SanitizedFailure };

export type PrototypeGate = {
  prototypeEnabled: boolean;
};

export function createDefaultWorkspaceMemoryProfile(workspaceId: string): WorkspaceMemoryProfile {
  return {
    workspaceId,
    desired: "off",
    observed: "ready",
    generation: 0,
    activationCursor: null,
    reconcileKind: null,
    sanitizedFailure: null,
  };
}

export function parseDesiredWorkspaceMemoryProfile(
  value: unknown,
): DesiredWorkspaceMemoryProfile | null {
  return typeof value === "string" &&
    (DESIRED_WORKSPACE_MEMORY_PROFILES as readonly string[]).includes(value)
    ? (value as DesiredWorkspaceMemoryProfile)
    : null;
}

export function parseObservedWorkspaceMemoryState(
  value: unknown,
): ObservedWorkspaceMemoryState | null {
  return typeof value === "string" &&
    (OBSERVED_WORKSPACE_MEMORY_STATES as readonly string[]).includes(value)
    ? (value as ObservedWorkspaceMemoryState)
    : null;
}

function rejectIfStale(
  current: WorkspaceMemoryProfile,
  generation: number,
): ProfileCommandResult | undefined {
  if (generation !== current.generation) {
    return { ok: false, failure: sanitizeWorkspaceMemoryFailure("stale_generation") };
  }
  return undefined;
}

function cursorFor(at: Date, afterMessageId?: string): ActivationCursor {
  const occurredAt = at.toISOString();
  return afterMessageId
    ? { kind: "message", occurredAt, messageId: afterMessageId }
    : { kind: "time", occurredAt };
}

export function applyWorkspaceMemoryCommand(
  current: WorkspaceMemoryProfile,
  command: WorkspaceMemoryCommand,
  gate: PrototypeGate = { prototypeEnabled: false },
): ProfileCommandResult {
  switch (command.type) {
    case "select_desired":
      return selectDesired(current, command, gate);
    case "observe_ready":
      return observeReady(current, command.generation);
    case "observe_degraded":
      return observeDegraded(current, command.generation);
    case "observe_error":
      return observeError(current, command.generation, command.failure);
    case "retry":
      return retry(current, command.generation);
  }
}

function selectDesired(
  current: WorkspaceMemoryProfile,
  command: Extract<WorkspaceMemoryCommand, { type: "select_desired" }>,
  gate: PrototypeGate,
): ProfileCommandResult {
  if (command.desired !== "off" && !gate.prototypeEnabled) {
    return { ok: false, failure: sanitizeWorkspaceMemoryFailure("prototype_disabled") };
  }
  if (command.desired === current.desired && current.observed !== "error") {
    return { ok: true, profile: current };
  }

  const reconcileKind: ReconcileKind =
    current.desired === "off" && command.desired !== "off" ? "provision" : "switch";
  const activationCursor =
    command.desired === "off"
      ? current.activationCursor
      : cursorFor(command.at, command.afterMessageId);

  return {
    ok: true,
    profile: {
      ...current,
      desired: command.desired,
      observed: reconcileKind === "provision" ? "provisioning" : "switching",
      generation: current.generation + 1,
      activationCursor,
      reconcileKind,
      sanitizedFailure: null,
    },
  };
}

function observeReady(current: WorkspaceMemoryProfile, generation: number): ProfileCommandResult {
  const stale = rejectIfStale(current, generation);
  if (stale) return stale;
  if (current.observed === "ready") return { ok: true, profile: current };
  if (
    current.observed !== "provisioning" &&
    current.observed !== "switching" &&
    current.observed !== "degraded"
  ) {
    return { ok: false, failure: sanitizeWorkspaceMemoryFailure("invalid_transition") };
  }
  return {
    ok: true,
    profile: {
      ...current,
      observed: "ready",
      reconcileKind: null,
      sanitizedFailure: null,
    },
  };
}

function observeDegraded(
  current: WorkspaceMemoryProfile,
  generation: number,
): ProfileCommandResult {
  const stale = rejectIfStale(current, generation);
  if (stale) return stale;
  if (
    current.desired === "off" ||
    (current.observed !== "ready" && current.observed !== "degraded")
  ) {
    return { ok: false, failure: sanitizeWorkspaceMemoryFailure("invalid_transition") };
  }
  return { ok: true, profile: { ...current, observed: "degraded" } };
}

function observeError(
  current: WorkspaceMemoryProfile,
  generation: number,
  failure: SanitizedFailure,
): ProfileCommandResult {
  const stale = rejectIfStale(current, generation);
  if (stale) return stale;
  if (current.observed !== "provisioning" && current.observed !== "switching") {
    return { ok: false, failure: sanitizeWorkspaceMemoryFailure("invalid_transition") };
  }
  return {
    ok: true,
    profile: {
      ...current,
      observed: "error",
      sanitizedFailure: failure,
    },
  };
}

function retry(current: WorkspaceMemoryProfile, generation: number): ProfileCommandResult {
  const stale = rejectIfStale(current, generation);
  if (stale) return stale;
  if (current.observed !== "error") {
    return { ok: false, failure: sanitizeWorkspaceMemoryFailure("invalid_transition") };
  }
  return {
    ok: true,
    profile: {
      ...current,
      observed: current.reconcileKind === "switch" ? "switching" : "provisioning",
      sanitizedFailure: null,
    },
  };
}
