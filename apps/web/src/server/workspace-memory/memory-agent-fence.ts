/**
 * Profile → Memory Agent fence mapping. Workspace-memory owns this decision;
 * The openviking-memory fence is consumed from the injected lookup.
 */

import { workspaceProfileToToolFence, type MemoryAgentToolProfile } from "@lrm/coforge-sdk/agent";
import type { DesiredWorkspaceMemoryProfile } from "./profile";
import type { WorkspaceMemoryProfileStore } from "./stores";

export type MemoryAgentFenceLookup = {
  resolve(workspaceId: string): Promise<MemoryAgentToolProfile | undefined>;
};

export function memoryAgentFenceForDesired(
  desired: DesiredWorkspaceMemoryProfile | null | undefined,
): MemoryAgentToolProfile | undefined {
  return workspaceProfileToToolFence(desired ?? "off");
}

export function createMemoryAgentFenceLookup(
  store: WorkspaceMemoryProfileStore,
): MemoryAgentFenceLookup {
  return {
    async resolve(workspaceId) {
      const profile = await store.get(workspaceId);
      return memoryAgentFenceForDesired(profile?.desired);
    },
  };
}
