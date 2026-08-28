import { Centrifuge } from "centrifuge/build/protobuf";
import {
  encodeWorkspaceWorkerReadyRequest,
  WORKSPACE_WORKER_READY_METHOD,
  type WorkspaceWorkerReadyRequest,
} from "@coforge/protocol";

/** Configuration identifying the Workspace Worker cloud connection. */
export interface WorkspaceWorkerCloudTransportConfig {
  workspaceId: string;
  computerId: string;
}

/** Provider-neutral port for one Workspace Worker's cloud connection. */
export interface WorkspaceWorkerCloudTransport {
  start(token: string, config: WorkspaceWorkerCloudTransportConfig): Promise<void>;
  ready(request: WorkspaceWorkerReadyRequest): Promise<void>;
  stop(): Promise<void>;
}

/** Creates the transport owned by one Workspace Worker. */
export interface WorkspaceWorkerCloudTransportFactory {
  create(config: WorkspaceWorkerCloudTransportConfig): WorkspaceWorkerCloudTransport;
}

export interface CentrifugeWorkspaceWorkerClient {
  on(event: "connected", callback: () => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  connect(): void;
  disconnect(): void;
  rpc?(method: string, data: Uint8Array): Promise<unknown>;
}

export type CentrifugeWorkspaceWorkerClientFactory = (
  endpoint: string,
  token: string,
) => CentrifugeWorkspaceWorkerClient;

export const defaultCentrifugeWorkspaceWorkerClientFactory: CentrifugeWorkspaceWorkerClientFactory =
  (endpoint, token) =>
    new Centrifuge(endpoint, {
      token,
      websocket: globalThis.WebSocket,
    }) as unknown as CentrifugeWorkspaceWorkerClient;

/** A lifecycle-only Centrifugo connection; business RPC is intentionally not implemented here. */
export class CentrifugoWorkspaceWorkerTransport implements WorkspaceWorkerCloudTransport {
  #client: CentrifugeWorkspaceWorkerClient | undefined;
  #connected = false;

  constructor(
    private readonly endpoint: string,
    private readonly clientFactory: CentrifugeWorkspaceWorkerClientFactory = defaultCentrifugeWorkspaceWorkerClientFactory,
  ) {
    if (!endpoint) throw new Error("cloud endpoint not configured");
  }

  async start(_token: string, _config: WorkspaceWorkerCloudTransportConfig): Promise<void> {
    if (this.#connected) return;
    const client = this.clientFactory(this.endpoint, _token);
    this.#client = client;
    await new Promise<void>((resolve, reject) => {
      client.on("connected", () => {
        this.#connected = true;
        resolve();
      });
      client.on("error", reject);
      client.connect();
    }).catch((error) => {
      client.disconnect();
      this.#client = undefined;
      throw error;
    });
  }

  async ready(request: WorkspaceWorkerReadyRequest): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("cloud transport is not connected");
    if (!this.#client.rpc) throw new Error("Centrifugo RPC is unavailable");
    await this.#client.rpc(
      WORKSPACE_WORKER_READY_METHOD,
      encodeWorkspaceWorkerReadyRequest(request),
    );
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#connected = false;
    client?.disconnect();
  }
}
