import { Centrifuge } from "centrifuge/build/protobuf";
import {
  decodeAgentStartIntent,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  decodeAgentMessageDelivery,
  encodeAgentActivity,
  encodeAgentStatus,
  encodeAgentMessageDeliveryAck,
  encodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  DAEMON_RUNTIME_READY_METHOD,
  DAEMON_CONNECTION_STATUS_METHOD,
  DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_STATUS_METHOD,
  type DaemonRuntimeReadyRequest,
  type DaemonRuntimeCodeAgentsUpdateRequest,
  type DaemonRuntimeUsageScanRequest,
  type AgentActivity,
  type AgentStatus,
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
import { isAgentApiKey } from "../credentials/agent-api-key";
import type { AgentRuntimeProviderConfig } from "../code-agent/contract";

export type AgentLaunchConfig = {
  agentApiKey: string;
  providerConfig?: AgentRuntimeProviderConfig;
};

const AGENT_STATUS_REFRESH_MS = 30_000;
const RECONNECT_READY_RETRY_MS = 1_000;

export interface DaemonConnectionTiming {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

const defaultDaemonConnectionTiming: DaemonConnectionTiming = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

/** Configuration identifying the daemon's Workspace connection. */
export interface DaemonConnectionConfig {
  workspaceId: string;
  computerId: string;
  /** Server HTTP origin used only for Agent read/send RPCs. */
  serverHttpUrl?: string;
}

export interface AgentMessageHttpClient {
  request(input: {
    url: string;
    agentApiKey: string;
    daemonApiKey: string;
    request: AgentMessageRequest;
  }): Promise<CloudAgentMessageResponse>;
}

/** Provider-neutral client contract for the daemon's Workspace connection. */
export interface DaemonConnectionClient {
  start(token: string, config: DaemonConnectionConfig): Promise<void>;
  ready(createRequest: () => DaemonRuntimeReadyRequest): Promise<void>;
  updateCodeAgents?(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void>;
  onUsageScan?(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void;
  sendUsageScanResult?(
    response: import("@coforge/protocol").DaemonRuntimeUsageScanResponse,
  ): Promise<void>;
  stop(): Promise<void>;
  onReconnect?(callback: () => void): () => void;
  onAgentStart?(callback: (intent: AgentStartIntent) => void): () => void;
  onAgentMessage?(callback: (message: AgentMessageDelivery) => void): () => void;
  sendAgentActivity?(activity: AgentActivity): void;
  sendAgentStatus?(status: AgentStatus): void;
  sendAgentDeliveryAck?(ack: AgentMessageDeliveryAck): Promise<void>;
  agentMessage?(
    request: AgentMessageRequest,
    agentApiKey?: string,
  ): Promise<CloudAgentMessageResponse>;
  agentAttachment?(attachmentId: string, agentApiKey?: string): Promise<Response>;
  requestAgentApiKey?(input: { agentId: string; workspaceId: string }): Promise<string>;
  requestAgentLaunchConfig?(input: {
    agentId: string;
    workspaceId: string;
  }): Promise<AgentLaunchConfig>;
  revokeAgentApiKey?(agentApiKey: string): Promise<void>;
}

/** Creates the Daemon connection client owned by the daemon. */
export interface DaemonConnectionClientFactory {
  create(config: DaemonConnectionConfig): DaemonConnectionClient;
}

export interface CentrifugeWorkspaceClient {
  on(event: "connected", callback: () => void): void;
  on(event: "disconnected", callback: () => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  on(
    event: "publication",
    callback: (publication: { channel: string; data: Uint8Array }) => void,
  ): void;
  connect(): void;
  disconnect(): void;
  rpc(method: string, data: Uint8Array): Promise<unknown>;
  publish?(channel: string, data: Uint8Array): Promise<unknown>;
  newSubscription?(channel: string): CentrifugeWorkspaceSubscription;
}

interface CentrifugeWorkspaceSubscription {
  on(event: "publication", callback: (publication: { data: Uint8Array }) => void): void;
  subscribe(): void;
  unsubscribe(): void;
}

export type CentrifugeWorkspaceClientFactory = (
  endpoint: string,
  token: string,
  data?: Uint8Array,
) => CentrifugeWorkspaceClient;

export const defaultCentrifugeWorkspaceClientFactory: CentrifugeWorkspaceClientFactory = (
  endpoint,
  _token,
  data,
) =>
  new Centrifuge(endpoint, {
    data,
    websocket: globalThis.WebSocket,
  }) as unknown as CentrifugeWorkspaceClient;

export const defaultAgentMessageHttpClient: AgentMessageHttpClient = {
  async request({ url, agentApiKey, daemonApiKey, request }) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemonApiKey}`,
        "x-coforge-agent-api-key": `Bearer ${agentApiKey}`,
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

/** The Daemon's single connection for its configured Workspace. */
export class DaemonConnection implements DaemonConnectionClient {
  #client: CentrifugeWorkspaceClient | undefined;
  #daemonSubscription: CentrifugeWorkspaceSubscription | undefined;
  #connected = false;
  #hasConnected = false;
  #agentStartListener: ((intent: AgentStartIntent) => void) | undefined;
  #agentMessageListener: ((message: AgentMessageDelivery) => void) | undefined;
  #readyPublications: Array<AgentStartIntent | AgentMessageDelivery> | undefined;
  #token = "";
  #readyRequestFactory: (() => DaemonRuntimeReadyRequest) | undefined;
  #reconnectListener: (() => void) | undefined;
  #readyRecoveryClient: CentrifugeWorkspaceClient | undefined;
  #readyRetryTimer: unknown;
  readonly #pendingActivity = new Map<string, AgentActivity>();
  readonly #supersededActivityLaunches = new Map<string, Set<string>>();
  readonly #latestStatuses = new Map<string, AgentStatus>();
  #statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  #statusRpcQueue = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly clientFactory: CentrifugeWorkspaceClientFactory = defaultCentrifugeWorkspaceClientFactory,
    private readonly agentMessageHttpClient: AgentMessageHttpClient = defaultAgentMessageHttpClient,
    private readonly timing: DaemonConnectionTiming = defaultDaemonConnectionTiming,
  ) {
    if (!endpoint) throw new Error("cloud endpoint not configured");
  }

  async start(_token: string, config: DaemonConnectionConfig): Promise<void> {
    this.#token = _token;
    this.#serverHttpUrl = config.serverHttpUrl ?? "";
    if (this.#connected) return;
    const client = this.clientFactory(
      this.endpoint,
      "",
      new TextEncoder().encode(JSON.stringify({ daemonApiKey: _token })),
    );
    this.#client = client;
    const daemonChannel = this.#daemonChannel(config.computerId);
    if (!client.newSubscription) {
      client.on("publication", ({ channel, data }) => {
        if (client !== this.#client || channel !== daemonChannel) return;
        this.#handleAgentPublication(data, config.workspaceId);
      });
    }
    const subscription = client.newSubscription?.(daemonChannel);
    this.#daemonSubscription = subscription;
    subscription?.on("publication", ({ data }) => {
      if (client === this.#client) {
        this.#handleAgentPublication(data, config.workspaceId);
      }
    });
    subscription?.subscribe();
    client.on("disconnected", () => {
      if (client === this.#client) {
        this.#connected = false;
        this.#cancelReadyRecovery();
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("connected", () => {
        if (client !== this.#client) return;
        const reconnect = this.#hasConnected;
        this.#connected = true;
        this.#hasConnected = true;
        void client
          .rpc(
            DAEMON_CONNECTION_STATUS_METHOD,
            new TextEncoder().encode(
              JSON.stringify({
                workspaceId: config.workspaceId,
                computerId: config.computerId,
                online: true,
              }),
            ),
          )
          .catch(() => {});
        this.#flushPendingActivity(client);
        this.#flushLatestStatuses(client);
        this.#startStatusRefresh();
        if (reconnect && this.#readyRequestFactory) {
          this.#readyPublications ??= [];
          this.#startReadyRecovery(client, this.#readyRequestFactory);
        }
        resolve();
      });
      client.on("error", reject);
      client.connect();
    }).catch((error) => {
      this.#cancelReadyRecovery();
      subscription?.unsubscribe();
      this.#daemonSubscription = undefined;
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

  onReconnect(callback: () => void): () => void {
    this.#reconnectListener = callback;
    return () => {
      if (this.#reconnectListener === callback) this.#reconnectListener = undefined;
    };
  }

  sendAgentActivity(activity: AgentActivity): void {
    const pending = this.#pendingActivity.get(activity.agentId);
    if (this.#supersededActivityLaunches.get(activity.agentId)?.has(activity.launchId)) return;
    if (pending?.launchId === activity.launchId && pending.clientSeq >= activity.clientSeq) return;
    if (pending && pending.launchId !== activity.launchId) {
      const superseded =
        this.#supersededActivityLaunches.get(activity.agentId) ?? new Set<string>();
      superseded.add(pending.launchId);
      this.#supersededActivityLaunches.set(activity.agentId, superseded);
    }
    if (!this.#connected || !this.#client?.publish) {
      this.#pendingActivity.set(activity.agentId, activity);
      return;
    }
    void this.#client
      .publish(this.#activityChannel(activity.workspaceId), encodeAgentActivity(activity))
      .catch(() => {
        // Activity is an observation. Failure must not block Agent work or be retried.
      });
  }

  sendAgentStatus(status: AgentStatus): void {
    this.#latestStatuses.set(status.agentId, status);
    if (!this.#connected || !this.#client) return;
    this.#queueAgentStatus(this.#client, status);
  }

  #flushPendingActivity(client: CentrifugeWorkspaceClient): void {
    if (!client.publish) return;
    const pending = [...this.#pendingActivity.values()];
    this.#pendingActivity.clear();
    this.#supersededActivityLaunches.clear();
    for (const activity of pending) {
      void client
        .publish(this.#activityChannel(activity.workspaceId), encodeAgentActivity(activity))
        .catch(() => {});
    }
  }

  #flushLatestStatuses(client: CentrifugeWorkspaceClient): void {
    for (const status of this.#latestStatuses.values()) {
      this.#queueAgentStatus(client, status);
    }
  }

  #queueAgentStatus(client: CentrifugeWorkspaceClient, status: AgentStatus): void {
    this.#statusRpcQueue = this.#statusRpcQueue
      .then(async () => {
        if (!this.#connected || client !== this.#client) return;
        await client.rpc(AGENT_STATUS_METHOD, encodeAgentStatus(status));
      })
      .catch(() => {});
  }

  #startStatusRefresh(): void {
    if (this.#statusRefreshTimer) return;
    this.#statusRefreshTimer = setInterval(() => {
      const client = this.#client;
      if (!this.#connected || !client) return;
      for (const status of this.#latestStatuses.values()) {
        if (status.status !== "active") continue;
        this.#queueAgentStatus(client, { ...status, requestId: crypto.randomUUID() });
      }
    }, AGENT_STATUS_REFRESH_MS);
    this.#statusRefreshTimer.unref();
  }

  async sendAgentDeliveryAck(ack: AgentMessageDeliveryAck): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    await this.#client.rpc(AGENT_MESSAGE_ACK_METHOD, encodeAgentMessageDeliveryAck(ack));
  }
  async agentMessage(
    request: AgentMessageRequest,
    agentApiKey?: string,
  ): Promise<CloudAgentMessageResponse> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    if (!this.#serverHttpUrl) throw new Error("Agent message HTTP endpoint is not configured");
    return this.agentMessageHttpClient.request({
      url: `${new URL(this.#serverHttpUrl).origin}/api/agent-messages`,
      agentApiKey: agentApiKey ?? this.#token,
      daemonApiKey: this.#token,
      request,
    });
  }

  async agentAttachment(attachmentId: string, agentApiKey?: string): Promise<Response> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    if (!this.#serverHttpUrl) throw new Error("Agent attachment endpoint is not configured");
    return fetch(
      `${new URL(this.#serverHttpUrl).origin}/api/agent/attachments/${encodeURIComponent(attachmentId)}`,
      {
        headers: {
          authorization: `Bearer ${this.#token}`,
          "x-coforge-agent-api-key": `Bearer ${agentApiKey ?? this.#token}`,
        },
      },
    );
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
    if (typeof value.apiKey !== "string" || !isAgentApiKey(value.apiKey))
      throw new Error("invalid Agent API key response");
    return value.apiKey;
  }

  async requestAgentLaunchConfig(input: {
    agentId: string;
    workspaceId: string;
  }): Promise<AgentLaunchConfig> {
    if (!this.#serverHttpUrl) throw new Error("Agent launch config endpoint is not configured");
    const response = await fetch(`${new URL(this.#serverHttpUrl).origin}/api/agent-api-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Agent launch config request failed (${response.status})`);
    const value = (await response.json()) as { apiKey?: unknown; providerConfig?: unknown };
    if (typeof value.apiKey !== "string" || !isAgentApiKey(value.apiKey))
      throw new Error("invalid Agent API key response");
    const providerConfig = parseAgentRuntimeProviderConfig(value.providerConfig);
    return {
      agentApiKey: value.apiKey,
      ...(providerConfig ? { providerConfig } : {}),
    };
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

  #daemonChannel(computerId: string): string {
    return `daemon:${computerId}`;
  }

  #activityChannel(workspaceId: string): string {
    return `activity:${workspaceId}`;
  }

  #handleAgentPublication(data: Uint8Array, workspaceId: string): void {
    try {
      const usage = decodeDaemonRuntimeUsageScanRequest(data);
      if (usage.protocolMajor === 1 && usage.workspaceId === workspaceId && usage.computerId) {
        void this.#usageScanListener?.(usage);
        return;
      }
    } catch {}
    try {
      try {
        const message = decodeAgentMessageDelivery(data);
        if (message.protocolMajor !== 1 || message.workspaceId !== workspaceId)
          throw new Error("agent message targets another Workspace");
        if (this.#readyPublications) this.#readyPublications.push(message);
        else this.#agentMessageListener?.(message);
      } catch {
        const intent = decodeAgentStartIntent(data);
        if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId)
          throw new Error("agent intent targets another Workspace");
        if (this.#readyPublications) this.#readyPublications.push(intent);
        else this.#agentStartListener?.(intent);
      }
    } catch {
      // Invalid publications are rejected at the protocol boundary and never reach the runtime.
    }
  }

  #usageScanListener: ((request: DaemonRuntimeUsageScanRequest) => Promise<void>) | undefined;
  onUsageScan(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void {
    this.#usageScanListener = callback;
    return () => {
      if (this.#usageScanListener === callback) this.#usageScanListener = undefined;
    };
  }
  async sendUsageScanResult(
    response: import("@coforge/protocol").DaemonRuntimeUsageScanResponse,
  ): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    await this.#client.rpc(
      DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
      encodeDaemonRuntimeUsageScanResponse(response),
    );
  }

  async ready(createRequest: () => DaemonRuntimeReadyRequest): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    this.#readyPublications = [];
    try {
      await this.#sendReady(this.#client, createRequest());
      this.#readyRequestFactory = createRequest;
    } finally {
      this.#dispatchReadyPublications();
    }
  }

  async updateCodeAgents(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    await this.#client.rpc(
      DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
      encodeDaemonRuntimeCodeAgentsUpdateRequest(request),
    );
  }

  async #sendReady(
    client: CentrifugeWorkspaceClient,
    request: DaemonRuntimeReadyRequest,
  ): Promise<void> {
    await client.rpc(DAEMON_RUNTIME_READY_METHOD, encodeDaemonRuntimeReadyRequest(request));
  }

  #startReadyRecovery(
    client: CentrifugeWorkspaceClient,
    createRequest: () => DaemonRuntimeReadyRequest,
  ): void {
    if (this.#readyRecoveryClient === client) return;
    this.#cancelReadyRecovery();
    this.#readyRecoveryClient = client;
    void this.#attemptReadyRecovery(client, createRequest);
  }

  async #attemptReadyRecovery(
    client: CentrifugeWorkspaceClient,
    createRequest: () => DaemonRuntimeReadyRequest,
  ): Promise<void> {
    if (client !== this.#client || client !== this.#readyRecoveryClient || !this.#connected) return;
    try {
      await this.#sendReady(client, createRequest());
    } catch {
      if (client !== this.#client || client !== this.#readyRecoveryClient || !this.#connected)
        return;
      this.#readyRetryTimer = this.timing.schedule(() => {
        this.#readyRetryTimer = undefined;
        void this.#attemptReadyRecovery(client, createRequest);
      }, RECONNECT_READY_RETRY_MS);
      return;
    }
    if (client !== this.#client || client !== this.#readyRecoveryClient || !this.#connected) return;
    this.#readyRecoveryClient = undefined;
    this.#dispatchReadyPublications();
    this.#reconnectListener?.();
  }

  #cancelReadyRecovery(): void {
    if (this.#readyRetryTimer !== undefined) this.timing.cancel(this.#readyRetryTimer);
    this.#readyRetryTimer = undefined;
    this.#readyRecoveryClient = undefined;
  }

  #dispatchReadyPublications(): void {
    const publications = this.#readyPublications;
    this.#readyPublications = undefined;
    if (!publications) return;
    for (const publication of publications)
      if ("provider" in publication) this.#agentStartListener?.(publication);
    for (const publication of publications)
      if (!("provider" in publication)) this.#agentMessageListener?.(publication);
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#cancelReadyRecovery();
    if (this.#statusRefreshTimer) clearInterval(this.#statusRefreshTimer);
    this.#statusRefreshTimer = undefined;
    await this.#statusRpcQueue;
    this.#daemonSubscription?.unsubscribe();
    this.#daemonSubscription = undefined;
    this.#client = undefined;
    this.#connected = false;
    this.#hasConnected = false;
    this.#agentStartListener = undefined;
    this.#agentMessageListener = undefined;
    this.#readyPublications = undefined;
    this.#readyRequestFactory = undefined;
    this.#reconnectListener = undefined;
    this.#pendingActivity.clear();
    this.#supersededActivityLaunches.clear();
    this.#latestStatuses.clear();
    this.#statusRpcQueue = Promise.resolve();
    client?.disconnect();
  }
}

function parseAgentRuntimeProviderConfig(value: unknown): AgentRuntimeProviderConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("invalid Agent runtime provider config response");
  const config = value as Record<string, unknown>;
  if (config.kind === "default" && Object.keys(config).length === 1) return { kind: "default" };
  if (
    config.kind === "coforge" &&
    typeof config.providerId === "string" &&
    (config.apiKey === undefined || typeof config.apiKey === "string") &&
    Object.keys(config).every((key) => key === "kind" || key === "providerId" || key === "apiKey")
  )
    return {
      kind: "coforge",
      providerId: config.providerId,
      ...(typeof config.apiKey === "string" ? { apiKey: config.apiKey } : {}),
    };
  throw new Error("invalid Agent runtime provider config response");
}
