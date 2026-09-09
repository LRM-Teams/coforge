export type NativeProcessIdentity = { mainPid: number; active: boolean; invocationId: string };

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
