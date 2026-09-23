/** Read-only snapshot of what `coforge-computer status` reports. Every section is independent:
 * one unreachable or corrupt source degrades that section only, never the whole report. The one
 * exception is `install`: a corrupt or unreadable `active.json` fails the whole command, because
 * every other section is meaningless without knowing which Computer build is even running. */

import type { WorkspaceHealthState } from "@lrm/coforge-daemon";

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

/**
 * One Computer upgrade operation this Workspace binding has not yet settled with the server -
 * `pending` (an external job may still be running, or its receipt has not been swept yet),
 * `succeeded`, or `failed` (a report is owed but not yet acknowledged). An `acknowledged`
 * operation is audit-only history and is never listed here. Read-only: `status` never offers a
 * way to acknowledge one (Raft Computer 1.0.32 has the same single-slot rule
 * and shows the same thing under `raft-computer status`).
 */
export type UnsettledUpgradeOperation = {
  requestId: string;
  expectedVersion: string;
  state: "pending" | "succeeded" | "failed";
  /** How long ago this machine opened the operation, in milliseconds. */
  ageMs: number;
};

/** Where a Workspace's `pid` came from. The Coordinator's `daemon:snapshot` is the primary
 * source, but its cached OS-instance identity can go stale (e.g. the OS job was restarted by
 * `KeepAlive` after the Coordinator last observed it), reporting `processId: 0` for a Workspace
 * that is really running. `os-job` is the fallback: the same `cn.coforge.workspace.<identity>`
 * launchd job whose PID the Agents section already reads from one `launchctl list` call. */
export type WorkspacePidSource = "daemon-snapshot" | "os-job";

/** What the Workspace's own durable health journal reports (see `@lrm/coforge-daemon`'s
 * `WorkspaceHealthJournal`): `ok`, or latched `degraded` with the real reason, how many
 * unexpected deaths landed inside the crash window, and when the latch was set. An explicit
 * operator `restart` is the only thing that clears it. */
export type WorkspaceHealth = WorkspaceHealthState;

export type WorkspaceStatus = {
  workspaceId: string;
  serverHttpUrl: string | null;
  enabled: boolean;
  running: boolean;
  pid: number | null;
  pidSource: WorkspacePidSource | null;
  pending: PendingRequest[];
  unsettledUpgrades: UnsettledUpgradeOperation[];
  health: WorkspaceHealth;
};

export type WorkspacesStatus =
  | { readable: true; workspaces: WorkspaceStatus[] }
  | { readable: false; error: string };

export type AgentJob = { label: string; pid: number | null };
export type WorkspaceAgents = {
  workspaceId: string;
  /** The Workspace's own OS-containment job PID (darwin: `cn.coforge.workspace.<identity>`),
   * read from the same job listing as `jobs` below. `null` when unsupported or not loaded. */
  workspaceJobPid: number | null;
  jobs: AgentJob[];
  count: number;
};
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
  upgradeOperations?: {
    requestId: string;
    expectedVersion: string;
    state: "pending" | "succeeded" | "failed" | "acknowledged";
    requestedAt: number;
  }[];
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
  readWorkspaceHealth(workspaceId: string): Promise<WorkspaceHealth>;
}
