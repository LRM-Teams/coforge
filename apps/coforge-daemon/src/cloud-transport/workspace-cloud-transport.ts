import { Centrifuge } from "centrifuge/build/protobuf";
import {
  decodeAgentStartIntent,
  decodeAgentMessageDelivery,
  encodeAgentActivity,
  encodeAgentMessageDeliveryAck,
  encodeWorkspaceWorkerReadyRequest,
  WORKSPACE_WORKER_READY_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  type WorkspaceWorkerReadyRequest,
  type AgentActivity,
  type AgentStartIntent,
  type AgentMessageDelivery,
  type AgentMessageDeliveryAck,
  type AgentMessageRequest,
  type CloudAgentMessageResponse,
  encodeAgentMessageRequest,
  decodeCloudAgentMessageResponse,
  AGENT_MESSAGE_READ_METHOD,
  AGENT_MESSAGE_SEND_METHOD,
} from "@coforge/protocol";

/** Configuration identifying the daemon's Workspace cloud connection. */
export interface WorkspaceCloudTransportConfig {
  workspaceId: string;
  computerId: string;
  /** Server HTTP origin used only for Agent read/send RPCs. */
  serverHttpUrl?: string;
}

export interface AgentMessageHttpClient {
  request(input: {
    url: string;
    token: string;
    daemonToken: string;
    request: AgentMessageRequest;
  }): Promise<CloudAgentMessageResponse>;
}

/** Provider-neutral port for the daemon's Workspace cloud connection. */
export interface WorkspaceCloudTransport {
  start(token: string, config: WorkspaceCloudTransportConfig): Promise<void>;
  ready(request: WorkspaceWorkerReadyRequest): Promise<void>;
  stop(): Promise<void>;
  onAgentStart?(callback: (intent: AgentStartIntent) => void): () => void;
  onAgentMessage?(callback: (message: AgentMessageDelivery) => void): () => void;
  sendAgentActivity?(activity: AgentActivity): void;
  sendAgentDeliveryAck?(ack: AgentMessageDeliveryAck): Promise<void>;
  agentMessage?(
    request: AgentMessageRequest,
    agentApiKey?: string,
  ): Promise<CloudAgentMessageResponse>;
  requestAgentApiKey?(input: { agentId: string; workspaceId: string }): Promise<string>;
  revokeAgentApiKey?(agentApiKey: string): Promise<void>;
}

/** Creates the transport owned by the daemon. */
export interface WorkspaceCloudTransportFactory {
  create(config: WorkspaceCloudTransportConfig): WorkspaceCloudTransport;
}

export interface CentrifugeWorkspaceClient {
  on(event: "connected", callback: () => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  on(
    event: "publication",
    callback: (publication: { channel: string; data: Uint8Array }) => void,
  ): void;
  connect(): void;
  disconnect(): void;
  rpc(method: string, data: Uint8Array): Promise<unknown>;
  publish?(channel: string, data: Uint8Array): Promise<unknown>;
}

export type CentrifugeWorkspaceClientFactory = (
  endpoint: string,
  token: string,
) => CentrifugeWorkspaceClient;

export const defaultCentrifugeWorkspaceClientFactory: CentrifugeWorkspaceClientFactory = (
  endpoint,
  token,
) =>
  new Centrifuge(endpoint, {
    token,
    websocket: globalThis.WebSocket,
  }) as unknown as CentrifugeWorkspaceClient;

export const defaultAgentMessageHttpClient: AgentMessageHttpClient = {
  async request({ url, token, daemonToken, request }) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-coforge-daemon-authorization": `Bearer ${daemonToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method:
          request.operation === "read" ? AGENT_MESSAGE_READ_METHOD : AGENT_MESSAGE_SEND_METHOD,
        b64data: btoa(String.fromCharCode(...encodeAgentMessageRequest(request))),
      }),
    });
    if (!response.ok) throw new Error(`server agent request failed (${response.status})`);
    const envelope = (await response.json()) as { result?: { b64data?: string } };
    const bytes = Uint8Array.from(atob(envelope.result?.b64data ?? ""), (c) => c.charCodeAt(0));
    return decodeCloudAgentMessageResponse(bytes);
  },
};

/** A lifecycle-only Centrifugo connection; business RPC is intentionally not implemented here. */
export class CentrifugoWorkspaceTransport implements WorkspaceCloudTransport {
  #client: CentrifugeWorkspaceClient | undefined;
  #connected = false;
  #agentStartListener: ((intent: AgentStartIntent) => void) | undefined;
  #agentMessageListener: ((message: AgentMessageDelivery) => void) | undefined;
  #token = "";
  #lastReadyRequest: WorkspaceWorkerReadyRequest | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly clientFactory: CentrifugeWorkspaceClientFactory = defaultCentrifugeWorkspaceClientFactory,
    private readonly agentMessageHttpClient: AgentMessageHttpClient = defaultAgentMessageHttpClient,
  ) {
    if (!endpoint) throw new Error("cloud endpoint not configured");
  }

  async start(_token: string, config: WorkspaceCloudTransportConfig): Promise<void> {
    this.#token = _token;
    this.#serverHttpUrl = config.serverHttpUrl ?? "";
    if (this.#connected) return;
    const client = this.clientFactory(this.endpoint, _token);
    this.#client = client;
    client.on("publication", ({ channel, data }) => {
      if (client !== this.#client || channel !== this.#workspaceChannel(config.workspaceId)) return;
      this.#handleAgentPublication(data, config.workspaceId);
    });
    await new Promise<void>((resolve, reject) => {
      client.on("connected", () => {
        if (client !== this.#client) return;
        const reconnect = this.#connected;
        this.#connected = true;
        if (reconnect && this.#lastReadyRequest) {
          void this.#sendReady(client, this.#lastReadyRequest).catch(() => {
            // A reconnect handshake is best effort. A later reconnect retries
            // the last successful runtime registration.
          });
        }
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

  onAgentStart(callback: (intent: AgentStartIntent) => void): () => void {
    this.#agentStartListener = callback;
    return () => {
      if (this.#agentStartListener === callback) this.#agentStartListener = undefined;
    };
  }

  onAgentMessage(callback: (message: AgentMessageDelivery) => void): () => void {
    this.#agentMessageListener = callback;
    return () => {
      if (this.#agentMessageListener === callback) this.#agentMessageListener = undefined;
    };
  }

  sendAgentActivity(activity: AgentActivity): void {
    if (!this.#connected || !this.#client?.publish) return;
    void this.#client
      .publish(this.#activityChannel(activity.workspaceId), encodeAgentActivity(activity))
      .catch(() => {
        // Activity is an observation. Failure must not block Agent work or be retried.
      });
  }
  async sendAgentDeliveryAck(ack: AgentMessageDeliveryAck): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("cloud transport is not connected");
    await this.#client.rpc(AGENT_MESSAGE_ACK_METHOD, encodeAgentMessageDeliveryAck(ack));
  }
  async agentMessage(
    request: AgentMessageRequest,
    agentApiKey?: string,
  ): Promise<CloudAgentMessageResponse> {
    if (!this.#connected) throw new Error("cloud transport is not connected");
    if (!this.#serverHttpUrl) throw new Error("Agent message HTTP endpoint is not configured");
    return this.agentMessageHttpClient.request({
      url: `${new URL(this.#serverHttpUrl).origin}/api/agent-messages`,
      token: agentApiKey ?? this.#token,
      daemonToken: this.#token,
      request,
    });
  }

  async requestAgentApiKey(input: { agentId: string; workspaceId: string }): Promise<string> {
    if (!this.#serverHttpUrl) throw new Error("Agent API key endpoint is not configured");
    const response = await fetch(`${new URL(this.#serverHttpUrl).origin}/api/agent-api-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Agent API key request failed (${response.status})`);
    const value = (await response.json()) as { apiKey?: unknown };
    if (typeof value.apiKey !== "string" || !/^sk_agent_[A-Za-z0-9_-]{43}$/.test(value.apiKey))
      throw new Error("invalid Agent API key response");
    return value.apiKey;
  }

  async revokeAgentApiKey(agentApiKey: string): Promise<void> {
    if (!this.#serverHttpUrl) throw new Error("Agent API key endpoint is not configured");
    const response = await fetch(`${new URL(this.#serverHttpUrl).origin}/api/agent-api-keys`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: agentApiKey }),
    });
    if (!response.ok) throw new Error(`Agent API key revoke failed (${response.status})`);
  }

  #serverHttpUrl = "";

  #workspaceChannel(workspaceId: string): string {
    return `workspace:${workspaceId}`;
  }

  #activityChannel(workspaceId: string): string {
    return `activity:${workspaceId}`;
  }

  #handleAgentPublication(data: Uint8Array, workspaceId: string): void {
    try {
      try {
        const message = decodeAgentMessageDelivery(data);
        if (message.protocolMajor !== 1 || message.workspaceId !== workspaceId)
          throw new Error("agent message targets another Workspace");
        this.#agentMessageListener?.(message);
      } catch {
        const intent = decodeAgentStartIntent(data);
        if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId)
          throw new Error("agent intent targets another Workspace");
        this.#agentStartListener?.(intent);
      }
    } catch {
      // Invalid publications are rejected at the protocol boundary and never reach the runtime.
    }
  }

  async ready(request: WorkspaceWorkerReadyRequest): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("cloud transport is not connected");
    await this.#sendReady(this.#client, request);
    this.#lastReadyRequest = request;
  }

  async #sendReady(
    client: CentrifugeWorkspaceClient,
    request: WorkspaceWorkerReadyRequest,
  ): Promise<void> {
    await client.rpc(WORKSPACE_WORKER_READY_METHOD, encodeWorkspaceWorkerReadyRequest(request));
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#connected = false;
    this.#agentStartListener = undefined;
    this.#agentMessageListener = undefined;
    this.#lastReadyRequest = undefined;
    client?.disconnect();
  }
}
