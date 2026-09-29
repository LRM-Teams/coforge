import type { CoforgeMemoryActor, OpenVikingBinding } from "./contract";

export type OpenVikingBindingStore = {
  get(workspaceId: string): Promise<OpenVikingBinding | null>;
  compareAndSet(input: {
    workspaceId: string;
    expectedGeneration: number;
    binding: OpenVikingBinding;
  }): Promise<"saved" | "stale_generation">;
};

export type OpenVikingProvisioner = {
  provisionBinding(input: { workspaceId: string; generation: number }): Promise<OpenVikingBinding>;
  ensureMappedIdentities(input: {
    workspaceId: string;
    accountId: string;
    actors: readonly CoforgeMemoryActor[];
    generation: number;
  }): Promise<void>;
};

export function createInMemoryOpenVikingBindingStore(): OpenVikingBindingStore {
  const records = new Map<string, OpenVikingBinding>();
  return {
    async get(workspaceId) {
      const record = records.get(workspaceId);
      return record ? structuredClone(record) : null;
    },
    async compareAndSet({ workspaceId, expectedGeneration, binding }) {
      const currentGeneration = records.get(workspaceId)?.generation ?? 0;
      if (currentGeneration !== expectedGeneration || binding.generation < currentGeneration) {
        return "stale_generation";
      }
      records.set(workspaceId, structuredClone(binding));
      return "saved";
    },
  };
}

export function createFakeOpenVikingProvisioner(): OpenVikingProvisioner {
  return {
    async provisionBinding({ workspaceId, generation }) {
      return {
        workspaceId,
        accountId: `acct-${workspaceId}`,
        serviceIdentityId: `svc-projection-${workspaceId}`,
        credentialRef: `secret:ov-${workspaceId}`,
        generation,
      };
    },
    async ensureMappedIdentities() {},
  };
}
