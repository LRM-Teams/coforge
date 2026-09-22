import type { WorkspaceMemoryProfile } from "./profile";

export type WorkspaceMemoryProfileStore = {
  get(workspaceId: string): Promise<WorkspaceMemoryProfile | null>;
  compareAndSet(input: {
    workspaceId: string;
    expectedGeneration: number;
    profile: WorkspaceMemoryProfile;
  }): Promise<"saved" | "stale_generation">;
};

export function createInMemoryWorkspaceMemoryProfileStore(): WorkspaceMemoryProfileStore {
  const records = new Map<string, WorkspaceMemoryProfile>();
  return {
    async get(workspaceId) {
      const record = records.get(workspaceId);
      return record ? structuredClone(record) : null;
    },
    async compareAndSet({ workspaceId, expectedGeneration, profile }) {
      const currentGeneration = records.get(workspaceId)?.generation ?? 0;
      if (currentGeneration !== expectedGeneration || profile.generation < currentGeneration) {
        return "stale_generation";
      }
      records.set(workspaceId, structuredClone(profile));
      return "saved";
    },
  };
}

export async function saveProfileTransition(
  store: WorkspaceMemoryProfileStore,
  previous: WorkspaceMemoryProfile,
  next: WorkspaceMemoryProfile,
): Promise<"saved" | "stale_generation"> {
  if (next.generation < previous.generation || next.workspaceId !== previous.workspaceId) {
    return "stale_generation";
  }
  return store.compareAndSet({
    workspaceId: next.workspaceId,
    expectedGeneration: previous.generation,
    profile: next,
  });
}
