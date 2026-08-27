/** The daemon-owned identity used to start one workspace worker. */
export interface WorkspaceConnection {
  connectionId: string;
  workspaceId: string;
  workspaceRoot: string;
}

/** Provider-neutral lifecycle seam; cloud transport is intentionally outside it. */
export interface WorkspaceWorker {
  start(connection: WorkspaceConnection): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerFactory {
  create(connection: WorkspaceConnection): WorkspaceWorker;
}

export interface WorkspaceWorkerInfo {
  connectionId: string;
  workspaceId: string;
}

type Entry = {
  connection: WorkspaceConnection;
  worker: WorkspaceWorker;
};

export class WorkspaceWorkerSupervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<WorkspaceWorker>>();

  constructor(private readonly factory: WorkerFactory) {}

  async ensure(connection: WorkspaceConnection): Promise<WorkspaceWorker> {
    const existing = this.entries.get(connection.connectionId);
    if (existing) return existing.worker;

    const pending = this.starting.get(connection.connectionId);
    if (pending) return pending;

    const start = (async () => {
      try {
        const worker = this.factory.create(connection);
        await worker.start(connection);
        this.entries.set(connection.connectionId, { connection, worker });
        return worker;
      } finally {
        this.starting.delete(connection.connectionId);
      }
    })();
    this.starting.set(connection.connectionId, start);
    return start;
  }

  async stop(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId);
    if (!entry) return;
    await entry.worker.stop();
    this.entries.delete(connectionId);
  }

  query(connectionId: string): WorkspaceWorkerInfo | undefined {
    const entry = this.entries.get(connectionId);
    if (!entry) return undefined;
    return {
      connectionId: entry.connection.connectionId,
      workspaceId: entry.connection.workspaceId,
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((connectionId) => this.stop(connectionId)));
  }
}
