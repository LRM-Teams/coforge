import {
  RedisWorkspaceMemorySweepLock,
  ensureWorkspaceMemoryLifecycle,
  type WorkspaceMemoryLifecycle,
} from "../workspace-memory/lifecycle.server";
import type { WorkspaceMemorySweepLock } from "../workspace-memory/sweep";

/** Compatibility alias: P4 owns the production sweep. */
export type CausalAdmissionSweepLock = WorkspaceMemorySweepLock;
export const RedisCausalAdmissionSweepLock = RedisWorkspaceMemorySweepLock;

export function ensureCausalAdmissionSweep(): WorkspaceMemoryLifecycle | undefined {
  return ensureWorkspaceMemoryLifecycle();
}
