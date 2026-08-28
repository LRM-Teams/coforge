import { isAbsolute, parse } from "node:path";

/** The daemon-owned identity used to start one workspace worker. */
export interface WorkspaceConnection {
  workspaceId: string;
  computerId: string;
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
  workspaceId: string;
  computerId: string;
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
    validateWorkspaceRoot(connection.workspaceRoot);
    const existing = this.entries.get(connectionKey(connection));
    if (existing) return existing.worker;

    const pending = this.starting.get(connectionKey(connection));
    if (pending) return pending;

    const start = (async () => {
      try {
        const worker = this.factory.create(connection);
        await worker.start(connection);
        this.entries.set(connectionKey(connection), { connection, worker });
        return worker;
      } finally {
        this.starting.delete(connectionKey(connection));
      }
    })();
    this.starting.set(connectionKey(connection), start);
    return start;
  }

  async stop(workspaceId: string, computerId: string): Promise<void> {
    const entry = this.entries.get(workspaceComputerKey(workspaceId, computerId));
    if (!entry) return;
    await entry.worker.stop();
    this.entries.delete(workspaceComputerKey(workspaceId, computerId));
  }

  query(workspaceId: string, computerId: string): WorkspaceWorkerInfo | undefined {
    const entry = this.entries.get(workspaceComputerKey(workspaceId, computerId));
    if (!entry) return undefined;
    return {
      workspaceId: entry.connection.workspaceId,
      computerId: entry.connection.computerId,
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(({ connection }) =>
        this.stop(connection.workspaceId, connection.computerId),
      ),
    );
  }
}

function connectionKey(connection: WorkspaceConnection): string {
  return workspaceComputerKey(connection.workspaceId, connection.computerId);
}
function workspaceComputerKey(workspaceId: string, computerId: string): string {
  return `${workspaceId}\0${computerId}`;
}

/** Reject ambiguous roots before a worker can derive agent directories from them. */
export function validateWorkspaceRoot(workspaceRoot: string): void {
  if (!workspaceRoot || !isAbsolute(workspaceRoot) || parse(workspaceRoot).root === workspaceRoot) {
    throw new Error("workspaceRoot must be a non-root absolute Workspace directory");
  }
}
