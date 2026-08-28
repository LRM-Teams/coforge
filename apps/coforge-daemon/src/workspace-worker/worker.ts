import { AgentRuntimePool } from "../agent-capacity/agent-runtime-pool";
import type { AgentRuntimeConfig, CodeAgentProvider } from "../code-agent/contract";
import {
  AgentProcessManager,
  type AgentAdapterFactory,
  type AgentRuntime,
} from "../agent-runtime/agent-process-manager";
import type { WorkspaceConnection, WorkspaceWorker } from "./supervisor";
import type { WorkspaceWorkerCredentialStore } from "./credential-store";
import type {
  WorkspaceWorkerCloudTransport,
  WorkspaceWorkerCloudTransportFactory,
} from "../cloud-transport/workspace-worker-cloud-transport";
import { WORKSPACE_PROTOCOL_MAJOR } from "@coforge/protocol";

export function generateWorkerInstanceId(): string {
  return crypto.randomUUID();
}

/** The resident worker for one Workspace Connection. Cloud transport is added separately. */
export class WorkspaceWorkerImpl implements WorkspaceWorker {
  readonly #connection: WorkspaceConnection;
  readonly #agentProcessManager: AgentProcessManager;
  readonly #credentials: WorkspaceWorkerCredentialStore;
  readonly #transportFactory: WorkspaceWorkerCloudTransportFactory;
  #transport: WorkspaceWorkerCloudTransport;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #started = false;
  readonly #workerInstanceId = generateWorkerInstanceId();
  readonly #startedAt = Date.now();

  constructor(
    connection: WorkspaceConnection,
    pool: AgentRuntimePool,
    createAdapter: AgentAdapterFactory,
    credentials: WorkspaceWorkerCredentialStore,
    transportFactory: WorkspaceWorkerCloudTransportFactory,
  ) {
    this.#connection = connection;
    this.#agentProcessManager = new AgentProcessManager(
      pool,
      connection.connectionId,
      createAdapter,
    );
    this.#credentials = credentials;
    this.#transportFactory = transportFactory;
    this.#transport = transportFactory.create(connection);
  }

  get agentProcessManager(): AgentProcessManager {
    return this.#agentProcessManager;
  }

  start(connection: WorkspaceConnection): Promise<void> {
    if (connection.connectionId !== this.#connection.connectionId) {
      throw new Error("Workspace worker cannot be started for another connection");
    }
    if (this.#started) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#start(connection).finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  async #start(connection: WorkspaceConnection): Promise<void> {
    const token = await this.#credentials.load(this.#connection.connectionId);
    if (!token) throw new Error("Workspace Worker credential is missing");
    try {
      await this.#transport.start(token, {
        connectionId: connection.connectionId,
        workspaceId: connection.workspaceId,
      });
      await this.#transport.ready({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        workspaceId: connection.workspaceId,
        // Legacy connection records have no computer identity; the server rejects this.
        computerId: connection.computerId ?? "",
        workerInstanceId: this.#workerInstanceId,
        startedAt: this.#startedAt,
      });
      this.#started = true;
    } catch (error) {
      // A transport may retain partial state after a failed start; never reuse it.
      this.#transport = this.#transportFactory.create(this.#connection);
      throw error;
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

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop().finally(() => {
      this.#stopPromise = undefined;
    });
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch {
        // Startup cleanup below still needs to run after a failed start.
      }
    }
    let transportError: unknown;
    if (this.#started) {
      try {
        await this.#transport.stop();
      } catch (error) {
        transportError = error;
      } finally {
        this.#started = false;
        this.#transport = this.#transportFactory.create(this.#connection);
      }
    }
    try {
      await this.#agentProcessManager.shutdown();
    } catch (error) {
      if (transportError === undefined) throw error;
    }
    if (transportError !== undefined) throw transportError;
  }
}

export function createWorkspaceWorkerFactory(input: {
  pool: AgentRuntimePool;
  createAdapter: AgentAdapterFactory;
  credentials: WorkspaceWorkerCredentialStore;
  transportFactory: WorkspaceWorkerCloudTransportFactory;
}): (connection: WorkspaceConnection) => WorkspaceWorkerImpl {
  return (connection) =>
    new WorkspaceWorkerImpl(
      connection,
      input.pool,
      input.createAdapter,
      input.credentials,
      input.transportFactory,
    );
}

export type { AgentAdapterFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
