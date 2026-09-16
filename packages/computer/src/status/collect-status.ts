import type {
  ComputerStatusReport,
  DaemonSnapshotProbe,
  InstallStatus,
  PendingRequest,
  StatusBinding,
  StatusPorts,
  SupervisorStatus,
  WorkspacesStatus,
} from "./types";

/** Assembles the read-only status report from injected ports. Every section is collected
 * independently and degrades on its own failure; only `install` can fail the whole report,
 * because every other section is reported relative to "which build is active". */
export async function collectComputerStatus(ports: StatusPorts): Promise<ComputerStatusReport> {
  const install = await collectInstall(ports);
  const snapshot = await ports.probeDaemonSnapshot();
  const supervisor = await collectSupervisor(ports, snapshot);
  const bindingsLoad = await ports.loadBindings();
  const workspaces = collectWorkspaces(bindingsLoad, snapshot);
  const agents = await collectAgents(ports, bindingsLoad);
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
): WorkspacesStatus {
  if (!bindingsLoad.ok) return { readable: false, error: bindingsLoad.error };
  const runtimeByWorkspace = new Map(
    snapshot.reachable ? snapshot.runtimes.map((runtime) => [runtime.workspaceId, runtime]) : [],
  );
  return {
    readable: true,
    workspaces: bindingsLoad.bindings.map((binding) => {
      const runtime = runtimeByWorkspace.get(binding.workspaceId);
      const pid = runtime && runtime.processId > 0 ? runtime.processId : null;
      return {
        workspaceId: binding.workspaceId,
        serverHttpUrl: binding.serverHttpUrl ?? null,
        enabled: binding.enabled,
        running: pid !== null,
        pid,
        pending: pendingRequestsFor(binding),
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
