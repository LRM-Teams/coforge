/** Read-only snapshot of what `coforge-computer status` reports. Every section is independent:
 * one unreachable or corrupt source degrades that section only, never the whole report. The one
 * exception is `install`: a corrupt or unreadable `active.json` fails the whole command, because
 * every other section is meaningless without knowing which Computer build is even running. */

export type SupportedStatusPlatform = "darwin" | "linux" | "win32";

export type LockState = "held" | "free" | "unknown";

export type InstallStatus =
  | {
      readable: true;
      active: { current: string; previous: string | null } | null;
      binaryOnPath: string | null;
      resolvesToActive: boolean | null;
      releaseFeedUrl: string;
    }
  | { readable: false; error: string };

export type SupervisorRpcStatus =
  | { reachable: true; runtimeCount: number }
  | { reachable: false; error: string };

export type SupervisorStatus = {
  label: string;
  loaded: boolean;
  pid: number | null;
  socketPath: string;
  rpc: SupervisorRpcStatus;
};

export type PendingRequest =
  | { kind: "restart"; requestId: string; phase: string }
  | { kind: "upgrade"; requestId: string; expectedVersion: string };

export type WorkspaceStatus = {
  workspaceId: string;
  serverHttpUrl: string | null;
  enabled: boolean;
  running: boolean;
  pid: number | null;
  pending: PendingRequest[];
};

export type WorkspacesStatus =
  | { readable: true; workspaces: WorkspaceStatus[] }
  | { readable: false; error: string };

export type AgentJob = { label: string; pid: number | null };
export type WorkspaceAgents = { workspaceId: string; jobs: AgentJob[]; count: number };
export type AgentsStatus = { supported: boolean; workspaces: WorkspaceAgents[] };

export type LeftoverJob = { label: string; pid: number | null; runs: number | null };
export type LeftoverJobsStatus = { supported: boolean; jobs: LeftoverJob[] };

export type LocksStatus = {
  machineMutationLock: LockState;
  supervisorLock: { present: boolean; ownerPid: number | null };
};

export type ComputerStatusReport = {
  schemaVersion: 1;
  generatedAt: string;
  platform: SupportedStatusPlatform;
  install: InstallStatus;
  supervisor: SupervisorStatus;
  workspaces: WorkspacesStatus;
  agents: AgentsStatus;
  locks: LocksStatus;
  leftoverJobs: LeftoverJobsStatus;
};

/** The subset of a persisted Workspace binding the status report reads. Matches
 * `ManagedBinding` in `@lrm/coforge-daemon` but is declared locally so this package never
 * imports the Coordinator's mutable binding shape while it is being redesigned elsewhere. */
export type StatusBinding = {
  workspaceId: string;
  serverHttpUrl?: string;
  enabled: boolean;
  restart?: { requestId: string; phase: string };
  upgradeRequests?: { requestId: string; expectedVersion: string }[];
};

export type DaemonRuntimeSnapshotEntry = { workspaceId: string; processId: number };

export type DaemonSnapshotProbe =
  | { reachable: true; runtimes: DaemonRuntimeSnapshotEntry[] }
  | { reachable: false; error: string };

export type BindingsLoad = { ok: true; bindings: StatusBinding[] } | { ok: false; error: string };

export type ActiveInstallRead =
  | { kind: "present"; current: string; previous: string | null }
  | { kind: "absent" }
  | { kind: "corrupt"; error: string };

/** Injected readers for `collectComputerStatus`. Every method is a pure read: none may start,
 * stop, or otherwise mutate the Coordinator, a Workspace, or an Agent. */
export interface StatusPorts {
  now(): Date;
  platform: SupportedStatusPlatform;
  releaseFeedUrl: string;
  socketPath: string;
  readActiveInstall(): Promise<ActiveInstallRead>;
  locateBinaryOnPath(): Promise<string | null>;
  resolveRealPath(path: string): Promise<string | null>;
  activeBinaryPath: string;
  coordinatorLabel: string;
  probeCoordinator(): Promise<{ loaded: boolean; pid: number | null }>;
  probeDaemonSnapshot(): Promise<DaemonSnapshotProbe>;
  loadBindings(): Promise<BindingsLoad>;
  listWorkspaceAgents: {
    supported: boolean;
    list(bindings: StatusBinding[]): Promise<WorkspaceAgents[]>;
  };
  probeMachineMutationLock(): LockState;
  readSupervisorLockOwner(): Promise<number | null>;
  listLeftoverUpgradeJobs: { supported: boolean; list(): Promise<LeftoverJob[]> };
}
