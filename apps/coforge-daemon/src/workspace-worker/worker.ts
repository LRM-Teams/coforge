import { AgentRuntimePool } from "../agent-capacity/agent-runtime-pool";
import type { AgentRuntimeConfig, CodeAgentProvider } from "../code-agent/contract";
import {
  AgentProcessManager,
  type AgentAdapterFactory,
  type AgentRuntime,
} from "../agent-runtime/agent-process-manager";
import type { WorkspaceConnection, WorkspaceWorker } from "./supervisor";

/** The resident worker for one Workspace Connection. Cloud transport is added separately. */
export class WorkspaceWorkerImpl implements WorkspaceWorker {
  readonly #connection: WorkspaceConnection;
  readonly #agentProcessManager: AgentProcessManager;

  constructor(
    connection: WorkspaceConnection,
    pool: AgentRuntimePool,
    createAdapter: AgentAdapterFactory,
  ) {
    this.#connection = connection;
    this.#agentProcessManager = new AgentProcessManager(
      pool,
      connection.connectionId,
      createAdapter,
    );
  }

  get agentProcessManager(): AgentProcessManager {
    return this.#agentProcessManager;
  }

  async start(connection: WorkspaceConnection): Promise<void> {
    if (connection.connectionId !== this.#connection.connectionId) {
      throw new Error("Workspace worker cannot be started for another connection");
    }
  }

  startAgent(agentId: string, config: AgentRuntimeConfig): Promise<AgentRuntime> {
    return this.#agentProcessManager.start(
      agentId,
      config,
      `${this.#connection.workspaceRoot}/agents/${agentId}`,
    );
  }

  stopAgent(agentId: string): Promise<void> {
    return this.#agentProcessManager.stop(agentId);
  }

  async stop(): Promise<void> {
    await this.#agentProcessManager.shutdown();
  }
}

export function createWorkspaceWorkerFactory(input: {
  pool: AgentRuntimePool;
  createAdapter: AgentAdapterFactory;
}): (connection: WorkspaceConnection) => WorkspaceWorkerImpl {
  return (connection) => new WorkspaceWorkerImpl(connection, input.pool, input.createAdapter);
}

export type { AgentAdapterFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
