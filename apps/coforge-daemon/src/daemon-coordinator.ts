import {
  WorkspaceWorkerSupervisor,
  type WorkspaceConnection,
  type WorkspaceWorker,
  type WorkspaceWorkerInfo,
  type WorkerFactory,
} from "./workspace-worker/supervisor";

export interface DaemonCoordinator {
  configureWorkspaceWorker(connection: WorkspaceConnection): Promise<void>;
  startWorkspaceWorker(connection: WorkspaceConnection): Promise<WorkspaceWorker>;
  stopWorkspaceWorker(workspaceId: string, computerId: string): Promise<void>;
  getWorkspaceWorker(workspaceId: string, computerId: string): WorkspaceWorkerInfo | undefined;
  shutdown(): Promise<void>;
}

export function createDaemonCoordinator(input: {
  workerFactory: WorkerFactory;
}): DaemonCoordinator {
  const supervisor = new WorkspaceWorkerSupervisor(input.workerFactory);
  return {
    startWorkspaceWorker: (connection) => supervisor.ensure(connection),
    configureWorkspaceWorker: (connection) => supervisor.ensure(connection).then(() => undefined),
    stopWorkspaceWorker: (workspaceId, computerId) => supervisor.stop(workspaceId, computerId),
    getWorkspaceWorker: (workspaceId, computerId) => supervisor.query(workspaceId, computerId),
    shutdown: () => supervisor.shutdown(),
  };
}
