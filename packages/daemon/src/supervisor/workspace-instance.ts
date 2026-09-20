import { join } from "node:path";

export type NativeProcessIdentity = { mainPid: number; active: boolean; invocationId: string };

/** The single source of truth for where a Workspace's own state lives under the Coordinator's
 * state root - the same directory the Coordinator passes as `--state-directory` when it spawns
 * `__workspace-daemon`, and the only path a read-only observer (e.g. `coforge-computer status`)
 * may use to find that Workspace's durable state without recomputing the derivation itself. */
export function workspaceStateDirectory(stateRoot: string, workspaceId: string): string {
  return join(stateRoot, "workspaces", Buffer.from(workspaceId).toString("base64url"));
}

export type WorkspaceInstanceConfig = {
  stateRoot: string;
  workspaceId: string;
  executablePath: string;
  socketPath: string;
  stateDirectory: string;
  unitDirectory: string;
  supervisorSocketPath?: string;
  daemonConnectionEndpoint?: string;
};

export function validateWorkspaceEndpoint(value: string | undefined): void {
  if (!value) return;
  const endpoint = new URL(value);
  if (
    !["ws:", "wss:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Workspace endpoint must be a credential-free WebSocket URL");
}

export interface WorkspaceInstance {
  ensureStarted(): Promise<number>;
  stop(): Promise<void>;
  identity(): Promise<NativeProcessIdentity | null>;
}
