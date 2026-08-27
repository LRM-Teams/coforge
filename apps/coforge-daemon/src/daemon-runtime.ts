import {
  WorkspaceWorkerSupervisor,
  type WorkspaceConnection,
  type WorkspaceWorker,
  type WorkspaceWorkerInfo,
  type WorkerFactory,
} from "./workspace-worker/supervisor";

export interface DaemonRuntime {
  ensureConnection(connection: WorkspaceConnection): Promise<WorkspaceWorker>;
  stopConnection(connectionId: string): Promise<void>;
  queryConnection(connectionId: string): WorkspaceWorkerInfo | undefined;
  shutdown(): Promise<void>;
}

export function createDaemonRuntime(input: { workerFactory: WorkerFactory }): DaemonRuntime {
  const supervisor = new WorkspaceWorkerSupervisor(input.workerFactory);
  return {
    ensureConnection: (connection) => supervisor.ensure(connection),
    stopConnection: (connectionId) => supervisor.stop(connectionId),
    queryConnection: (connectionId) => supervisor.query(connectionId),
    shutdown: () => supervisor.shutdown(),
  };
}
