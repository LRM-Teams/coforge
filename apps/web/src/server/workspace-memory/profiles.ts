import { sanitizeWorkspaceMemoryFailure, type SanitizedFailure } from "./errors";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
  parseDesiredWorkspaceMemoryProfile,
  type ProfileCommandResult,
  type PrototypeGate,
  type WorkspaceMemoryProfile,
} from "./profile";
import { saveProfileTransition, type WorkspaceMemoryProfileStore } from "./stores";

export type SelectDesiredInput = {
  workspaceId: string;
  desired: string;
  at: Date;
  afterMessageId?: string;
  expectedGeneration?: number;
};

export type WorkspaceMemoryProfiles = {
  get(workspaceId: string): Promise<WorkspaceMemoryProfile>;
  selectDesired(input: SelectDesiredInput): Promise<ProfileCommandResult>;
};

export function createWorkspaceMemoryProfiles(deps: {
  store: WorkspaceMemoryProfileStore;
  gate?: PrototypeGate;
}): WorkspaceMemoryProfiles {
  const gate = deps.gate ?? { prototypeEnabled: false };
  return {
    async get(workspaceId) {
      return (
        (await deps.store.get(workspaceId)) ?? createDefaultWorkspaceMemoryProfile(workspaceId)
      );
    },
    async selectDesired(input) {
      const current =
        (await deps.store.get(input.workspaceId)) ??
        createDefaultWorkspaceMemoryProfile(input.workspaceId);
      if (
        input.expectedGeneration !== undefined &&
        input.expectedGeneration !== current.generation
      ) {
        return stale();
      }
      const desired = parseDesiredWorkspaceMemoryProfile(input.desired);
      if (!desired) {
        return { ok: false, failure: sanitizeWorkspaceMemoryFailure("invalid_profile") };
      }
      const applied = applyWorkspaceMemoryCommand(
        current,
        {
          type: "select_desired",
          desired,
          at: input.at,
          afterMessageId: input.afterMessageId,
        },
        gate,
      );
      if (!applied.ok || applied.profile.generation === current.generation) {
        return applied;
      }
      const saved = await saveProfileTransition(deps.store, current, applied.profile);
      return saved === "saved" ? applied : stale();
    },
  };
}

function stale(): { ok: false; failure: SanitizedFailure } {
  return { ok: false, failure: sanitizeWorkspaceMemoryFailure("stale_generation") };
}
