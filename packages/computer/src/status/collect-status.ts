import type {
  AgentsStatus,
  ComputerStatusReport,
  DaemonSnapshotProbe,
  InstallStatus,
  PendingRequest,
  StatusBinding,
  StatusPorts,
  SupervisorStatus,
  UnsettledUpgradeOperation,
  WorkspacesStatus,
} from "./types";

/** Assembles the read-only status report from injected ports. Every section is collected
 * independently and degrades on its own failure; only `install` can fail the whole report,
 * because every other section is reported relative to "which build is active". Agents is
 * collected before Workspaces because a Workspace's PID can fall back to the OS-job PID Agents
 * already reads. */
export async function collectComputerStatus(ports: StatusPorts): Promise<ComputerStatusReport> {
  const install = await collectInstall(ports);
  const snapshot = await ports.probeDaemonSnapshot();
  const supervisor = await collectSupervisor(ports, snapshot);
  const bindingsLoad = await ports.loadBindings();
  const agents = await collectAgents(ports, bindingsLoad);
  const workspaces = collectWorkspaces(bindingsLoad, snapshot, agents, ports.now());
  const leftoverJobs = await collectLeftoverJobs(ports);
  const supervisorLockOwnerPid = await ports.readSupervisorLockOwner();
  return {
    schemaVersion: 1,
    generatedAt: ports.now().toISOString(),
    platform: ports.platform,
    install,
    supervisor,
    workspaces,
    agents,
    locks: {
      machineMutationLock: ports.probeMachineMutationLock(),
      supervisorLock: {
        present: supervisorLockOwnerPid !== null,
        ownerPid: supervisorLockOwnerPid,
      },
    },
    leftoverJobs,
  };
}

async function collectInstall(ports: StatusPorts): Promise<InstallStatus> {
  const read = await ports.readActiveInstall();
  if (read.kind === "corrupt") return { readable: false, error: read.error };
  const active =
    read.kind === "present" ? { current: read.current, previous: read.previous } : null;
  const binaryOnPath = await ports.locateBinaryOnPath();
  const resolvesToActive = await resolveBinaryMatchesActive(ports, binaryOnPath, active !== null);
  return {
    readable: true,
    active,
    binaryOnPath,
    resolvesToActive,
    releaseFeedUrl: ports.releaseFeedUrl,
  };
}

async function resolveBinaryMatchesActive(
  ports: StatusPorts,
  binaryOnPath: string | null,
  hasActiveInstall: boolean,
): Promise<boolean | null> {
  if (!binaryOnPath || !hasActiveInstall) return null;
  const [onPathReal, activeReal] = await Promise.all([
    ports.resolveRealPath(binaryOnPath),
    ports.resolveRealPath(ports.activeBinaryPath),
  ]);
  if (!onPathReal || !activeReal) return null;
  return onPathReal === activeReal;
}

async function collectSupervisor(
  ports: StatusPorts,
  snapshot: DaemonSnapshotProbe,
): Promise<SupervisorStatus> {
  const coordinator = await ports.probeCoordinator();
  return {
    label: ports.coordinatorLabel,
    loaded: coordinator.loaded,
    pid: coordinator.pid,
    socketPath: ports.socketPath,
    rpc: snapshot.reachable
      ? { reachable: true, runtimeCount: snapshot.runtimes.length }
      : { reachable: false, error: snapshot.error },
  };
}

function collectWorkspaces(
  bindingsLoad: Awaited<ReturnType<StatusPorts["loadBindings"]>>,
  snapshot: DaemonSnapshotProbe,
  agents: AgentsStatus,
  now: Date,
): WorkspacesStatus {
  if (!bindingsLoad.ok) return { readable: false, error: bindingsLoad.error };
  const runtimeByWorkspace = new Map(
    snapshot.reachable ? snapshot.runtimes.map((runtime) => [runtime.workspaceId, runtime]) : [],
  );
  const osJobPidByWorkspace = new Map(
    agents.workspaces.map((workspace) => [workspace.workspaceId, workspace.workspaceJobPid]),
  );
  return {
    readable: true,
    workspaces: bindingsLoad.bindings.map((binding) => {
      const runtime = runtimeByWorkspace.get(binding.workspaceId);
      const snapshotPid = runtime && runtime.processId > 0 ? runtime.processId : null;
      // The Coordinator's snapshot can report 0 for a Workspace whose OS job it lost track of
      // (e.g. launchd's KeepAlive restarted it after the Coordinator last observed it) even
      // though the Workspace daemon is genuinely running. The OS job's own PID, read from the
      // same job listing Agents already uses, is a reliable fallback - and the report says which
      // source it came from rather than silently picking one.
      const osJobPid = osJobPidByWorkspace.get(binding.workspaceId) ?? null;
      const pid = snapshotPid ?? osJobPid;
      const pidSource =
        snapshotPid !== null ? "daemon-snapshot" : osJobPid !== null ? "os-job" : null;
      return {
        workspaceId: binding.workspaceId,
        serverHttpUrl: binding.serverHttpUrl ?? null,
        enabled: binding.enabled,
        running: pid !== null,
        pid,
        pidSource,
        pending: pendingRequestsFor(binding),
        unsettledUpgrades: unsettledUpgradesFor(binding, now),
      };
    }),
  };
}

function pendingRequestsFor(binding: StatusBinding): PendingRequest[] {
  const pending: PendingRequest[] = [];
  if (binding.restart) {
    pending.push({
      kind: "restart",
      requestId: binding.restart.requestId,
      phase: binding.restart.phase,
    });
  }
  for (const request of binding.upgradeRequests ?? []) {
    pending.push({
      kind: "upgrade",
      requestId: request.requestId,
      expectedVersion: request.expectedVersion,
    });
  }
  return pending;
}

/** Every Computer upgrade operation this binding still owes a settlement or a server report -
 * i.e. everything except `acknowledged`, which is audit-only history. Read-only, matching
 * `status`'s contract: this never settles, expires, or acknowledges anything itself. */
function unsettledUpgradesFor(binding: StatusBinding, now: Date): UnsettledUpgradeOperation[] {
  return (binding.upgradeOperations ?? [])
    .filter((operation) => operation.state !== "acknowledged")
    .map((operation) => ({
      requestId: operation.requestId,
      expectedVersion: operation.expectedVersion,
      state: operation.state as "pending" | "succeeded" | "failed",
      ageMs: Math.max(0, now.getTime() - operation.requestedAt),
    }));
}

async function collectAgents(
  ports: StatusPorts,
  bindingsLoad: Awaited<ReturnType<StatusPorts["loadBindings"]>>,
) {
  // "supported" describes the platform's capability (does a cheap job-listing helper exist at
  // all), never whether bindings happened to load this time - conflating the two would report
  // "not supported on this platform" for an unrelated bindings.json read failure.
  if (!ports.listWorkspaceAgents.supported || !bindingsLoad.ok) {
    return { supported: ports.listWorkspaceAgents.supported, workspaces: [] };
  }
  return {
    supported: true,
    workspaces: await ports.listWorkspaceAgents.list(bindingsLoad.bindings),
  };
}

async function collectLeftoverJobs(ports: StatusPorts) {
  if (!ports.listLeftoverUpgradeJobs.supported) return { supported: false, jobs: [] };
  return { supported: true, jobs: await ports.listLeftoverUpgradeJobs.list() };
}
