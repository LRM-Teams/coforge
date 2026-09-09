import { Centrifuge } from "centrifuge/build/protobuf";
import {
  decodeAgentWorkspaceResetRequest,
  encodeAgentControlResult,
  encodeAgentSessionReport,
  AGENT_CONTROL_RESULT_METHOD,
  AGENT_SESSION_METHOD,
  type AgentWorkspaceResetRequest,
  type AgentControlResult,
  type AgentSessionReport,
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentSkillsListRequest,
  encodeAgentSkillsListResult,
  AGENT_SKILLS_LIST_RESULT_METHOD,
  type AgentSkillsListRequest,
  type AgentSkillsListResult,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  decodeAgentMessageDelivery,
  decodeComputerRestartIntent,
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
  type AgentStopIntent,
  type AgentMessageDelivery,
  type AgentMessageDeliveryAck,
  type AgentMessageRequest,
  type CloudAgentMessageResponse,
  encodeAgentMessageRequest,
  decodeCloudAgentMessageResponse,
  AGENT_MESSAGE_READ_METHOD,
  AGENT_MESSAGE_SEARCH_METHOD,
  AGENT_MESSAGE_SEND_METHOD,
  AGENT_CHANNEL_MUTE_METHOD,
  AGENT_CHANNEL_UNMUTE_METHOD,
  AGENT_REMINDER_METHOD,
  REMINDER_FIRE_METHOD,
  REMINDER_SNAPSHOT_METHOD,
  REMINDER_SYNC_MESSAGE_TYPE,
  decodeAgentReminderOperationResponse,
  decodeReminderFireResponse,
  decodeReminderSync,
  encodeAgentReminderOperationRequest,
  encodeReminderFireRequest,
  encodeReminderSnapshotRequest,
  type AgentReminderOperationRequest,
  type AgentReminderOperationResponse,
  type ReminderFireRequest,
  type ReminderFireResponse,
  type ReminderSnapshotRequest,
  type ReminderSync,
  AGENT_THREAD_UNFOLLOW_METHOD,
  AGENT_TASK_METHOD,
  encodeTaskRequest,
  decodeTaskResponse,
  type TaskRequest,
  type TaskResponse,
} from "@coforge/protocol";
import { isAgentApiKey } from "../credentials/agent-api-key";
import type { AgentRuntimeProviderConfig } from "../code-agent/contract";
import { AgentMessageRequestError } from "./agent-message-request-error";
import { AgentTaskRequestError } from "./agent-task-request-error";
import { getLogger } from "@logtape/logtape";

export type AgentLaunchConfig = {
  agentApiKey: string;
  providerConfig?: AgentRuntimeProviderConfig;
};

const AGENT_STATUS_REFRESH_MS = 30_000;
const COMPUTER_STATUS_REFRESH_MS = 30_000;
const RECONNECT_READY_RETRY_MS = 1_000;
const logger = getLogger(["coforge", "daemon", "connection"]);

export interface DaemonConnectionTiming {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  scheduleRepeating?(callback: () => void, delayMs: number): unknown;
  cancelRepeating?(timer: unknown): void;
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
  /** Requests replacement of only this Workspace runtime. The supervisor supplies recovery evidence. */
  requestRestart?(requestId: string): Promise<void>;
}

export interface AgentMessageHttpClient {
  request(input: {
    url: string;
    agentApiKey: string;
    daemonApiKey: string;
    request: AgentMessageRequest;
  }): Promise<CloudAgentMessageResponse>;
  requestReminder?(input: {
    url: string;
    agentApiKey: string;
    daemonApiKey: string;
    request: AgentReminderOperationRequest;
  }): Promise<AgentReminderOperationResponse>;
}
export interface AgentTaskHttpClient {
  request(input: {
    url: string;
    agentApiKey: string;
    daemonApiKey: string;
    request: TaskRequest;
  }): Promise<TaskResponse>;
}

type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Provider-neutral client contract for the daemon's Workspace connection. */
export interface DaemonConnectionClient {
  onAgentWorkspaceReset?(callback: (request: AgentWorkspaceResetRequest) => void): () => void;
  sendAgentControlResult?(result: AgentControlResult): Promise<void>;
  start(token: string, config: DaemonConnectionConfig): Promise<void>;
  ready(createRequest: () => DaemonRuntimeReadyRequest): Promise<void>;
  updateCodeAgents?(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void>;
  onSkillsList?(callback: (request: AgentSkillsListRequest) => Promise<void>): () => void;
  sendSkillsListResult?(result: AgentSkillsListResult): Promise<void>;
  onUsageScan?(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void;
  sendUsageScanResult?(
    response: import("@coforge/protocol").DaemonRuntimeUsageScanResponse,
  ): Promise<void>;
  stop(): Promise<void>;
  onReconnect?(callback: () => void): () => void;
  onAgentStart?(callback: (intent: AgentStartIntent) => void): () => void;
  onAgentStop?(callback: (intent: AgentStopIntent) => void): () => void;
  onAgentMessage?(callback: (message: AgentMessageDelivery) => void): () => void;
  onReminderSync?(callback: (sync: ReminderSync) => void): () => void;
  requestSnapshot?(request: ReminderSnapshotRequest): Promise<ReminderSync>;
  fireReminder?(request: ReminderFireRequest): Promise<ReminderFireResponse>;
  agentReminder?(
    request: AgentReminderOperationRequest,
    agentApiKey: string,
  ): Promise<AgentReminderOperationResponse>;
  sendAgentActivity?(activity: AgentActivity): void;
  sendAgentStatus?(status: AgentStatus): void;
  reportAgentSession?(report: AgentSessionReport): Promise<void>;
  sendAgentDeliveryAck?(ack: AgentMessageDeliveryAck): Promise<void>;
  agentMessage?(
    request: AgentMessageRequest,
    agentApiKey?: string,
  ): Promise<CloudAgentMessageResponse>;
  agentTask?(request: TaskRequest, agentApiKey?: string): Promise<TaskResponse>;
  agentAttachment?(attachmentId: string, agentApiKey?: string): Promise<Response>;
  requestAgentApiKey?(input: { agentId: string; workspaceId: string }): Promise<string>;
  requestAgentLaunchConfig?(input: {
    agentId: string;
    workspaceId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
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

export const createAgentMessageHttpClient = (
  fetcher: HttpFetch = globalThis.fetch,
): AgentMessageHttpClient => ({
  async request({ url, agentApiKey, daemonApiKey, request }) {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemonApiKey}`,
        "x-coforge-agent-api-key": `Bearer ${agentApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: {
          read: AGENT_MESSAGE_READ_METHOD,
          search: AGENT_MESSAGE_SEARCH_METHOD,
          send: AGENT_MESSAGE_SEND_METHOD,
          mute: AGENT_CHANNEL_MUTE_METHOD,
          unmute: AGENT_CHANNEL_UNMUTE_METHOD,
          "thread-unfollow": AGENT_THREAD_UNFOLLOW_METHOD,
        }[request.operation],
        b64data: btoa(String.fromCharCode(...encodeAgentMessageRequest(request))),
      }),
    });
    if (!response.ok) throw new Error(`server agent request failed (${response.status})`);
    const envelope = (await response.json()) as {
      result?: { b64data?: string };
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof envelope.error?.code === "number" && typeof envelope.error.message === "string")
      throw AgentMessageRequestError.fromRpc(envelope.error.code, envelope.error.message);
    const bytes = Uint8Array.from(atob(envelope.result?.b64data ?? ""), (c) => c.charCodeAt(0));
    return decodeCloudAgentMessageResponse(bytes);
  },
  async requestReminder({ url, agentApiKey, daemonApiKey, request }) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemonApiKey}`,
          "x-coforge-agent-api-key": `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: AGENT_REMINDER_METHOD,
          b64data: bytesToBase64(encodeAgentReminderOperationRequest(request)),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Agent reminder request failed");
    }
    if (!response.ok) throw new Error(`Agent reminder request failed (${response.status})`);
    let envelope: { result?: { b64data?: string }; error?: unknown };
    try {
      envelope = (await response.json()) as typeof envelope;
    } catch {
      throw new Error("Agent reminder response is malformed");
    }
    if (envelope.error) throw new Error("Agent reminder RPC failed");
    try {
      return decodeAgentReminderOperationResponse(base64ToBytes(envelope.result?.b64data));
    } catch {
      throw new Error("Agent reminder response is malformed");
    }
  },
});

export const defaultAgentMessageHttpClient = createAgentMessageHttpClient();

export const defaultAgentTaskHttpClient: AgentTaskHttpClient = {
  async request({ url, agentApiKey, daemonApiKey, request }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${daemonApiKey}`,
        "x-coforge-agent-api-key": `Bearer ${agentApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: AGENT_TASK_METHOD,
        b64data: btoa(String.fromCharCode(...encodeTaskRequest(request))),
      }),
    });
    if (!response.ok) throw new Error(`server Agent Task request failed (${response.status})`);
    const envelope = (await response.json()) as {
      result?: { b64data?: string };
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof envelope.error?.code === "number")
      throw envelope.error.code === 400 && typeof envelope.error.message === "string"
        ? new AgentTaskRequestError(envelope.error.message)
        : envelope.error.code === 403
          ? new AgentTaskRequestError("Agent Task access denied")
          : new Error(`server Agent Task request failed (${envelope.error.code})`);
    const result = decodeTaskResponse(
      Uint8Array.from(atob(envelope.result?.b64data ?? ""), (c) => c.charCodeAt(0)),
    );
    if (result.requestId !== request.requestId)
      throw new Error("Task response request ID does not match request");
    return result;
  },
};

/** The Daemon's single connection for its configured Workspace. */
export class DaemonConnection implements DaemonConnectionClient {
  #client: CentrifugeWorkspaceClient | undefined;
  #connected = false;
  #hasConnected = false;
  #agentStartListener: ((intent: AgentStartIntent) => void) | undefined;
  #agentStopListener: ((intent: AgentStopIntent) => void) | undefined;
  #agentWorkspaceResetListener: ((intent: AgentWorkspaceResetRequest) => void) | undefined;
  #agentMessageListener: ((message: AgentMessageDelivery) => void) | undefined;
  #reminderSyncListener: ((sync: ReminderSync) => void) | undefined;
  #readyPublications:
    | Array<
        | { kind: "start"; value: AgentStartIntent }
        | { kind: "stop"; value: AgentStopIntent }
        | { kind: "workspace-reset"; value: AgentWorkspaceResetRequest }
        | { kind: "message"; value: AgentMessageDelivery }
        | { kind: "reminder"; value: ReminderSync }
      >
    | undefined;
  #token = "";
  #readyRequestFactory: (() => DaemonRuntimeReadyRequest) | undefined;
  #reconnectListener: (() => void) | undefined;
  #readyRecoveryClient: CentrifugeWorkspaceClient | undefined;
  #readyRetryTimer: unknown;
  readonly #pendingActivity = new Map<string, AgentActivity>();
  readonly #supersededActivityLaunches = new Map<string, Set<string>>();
  readonly #latestStatuses = new Map<string, AgentStatus>();
  readonly #restartRequestIds = new Set<string>();
  #statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  #computerStatusRefreshTimer: unknown;
  #statusRpcQueue = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly clientFactory: CentrifugeWorkspaceClientFactory = defaultCentrifugeWorkspaceClientFactory,
    private readonly agentMessageHttpClient: AgentMessageHttpClient = defaultAgentMessageHttpClient,
    private readonly timing: DaemonConnectionTiming = defaultDaemonConnectionTiming,
    private readonly agentTaskHttpClient: AgentTaskHttpClient = defaultAgentTaskHttpClient,
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
    const daemonChannel = this.#daemonChannel(config.workspaceId, config.computerId);
    client.on("publication", ({ channel, data }) => {
      if (client !== this.#client || channel !== daemonChannel) return;
      this.#handleAgentPublication(data, config);
    });
    client.on("disconnected", () => {
      if (client === this.#client) {
        this.#connected = false;
        this.#cancelReadyRecovery();
        logger.warning("Daemon cloud connection disconnected", {
          event: "daemon_connection:disconnected",
          workspace_id: config.workspaceId,
          computer_id: config.computerId,
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("connected", () => {
        if (client !== this.#client) return;
        const reconnect = this.#hasConnected;
        this.#connected = true;
        this.#hasConnected = true;
        logger.info("Daemon cloud connection established", {
          event: "daemon_connection:connected",
          workspace_id: config.workspaceId,
          computer_id: config.computerId,
          control_stream_binding: "connect_proxy",
          outcome: "ok",
        });
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
        this.#startStatusRefresh(config);
        if (reconnect && this.#readyRequestFactory) {
          this.#readyPublications ??= [];
          this.#startReadyRecovery(client, this.#readyRequestFactory);
        }
        resolve();
      });
      client.on("error", (error) => {
        logger.error("Daemon cloud connection failed", {
          event: "daemon_connection:failed",
          workspace_id: config.workspaceId,
          computer_id: config.computerId,
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
        reject(error);
      });
      client.connect();
    }).catch((error) => {
      this.#cancelReadyRecovery();
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

  onAgentStop(callback: (intent: AgentStopIntent) => void): () => void {
    this.#agentStopListener = callback;
    return () => {
      if (this.#agentStopListener === callback) this.#agentStopListener = undefined;
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

  #startStatusRefresh(config: DaemonConnectionConfig): void {
    if (!this.#statusRefreshTimer) {
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

    if (this.#computerStatusRefreshTimer) return;
    const refresh = () => {
      const client = this.#client;
      if (!this.#connected || !client) return;
      void client
        .rpc(
          DAEMON_CONNECTION_STATUS_METHOD,
          new TextEncoder().encode(JSON.stringify({ ...config, online: true })),
        )
        .catch(() => {});
    };
    this.#computerStatusRefreshTimer = this.timing.scheduleRepeating
      ? this.timing.scheduleRepeating(refresh, COMPUTER_STATUS_REFRESH_MS)
      : setInterval(refresh, COMPUTER_STATUS_REFRESH_MS);
    if (!this.timing.scheduleRepeating) {
      (this.#computerStatusRefreshTimer as ReturnType<typeof setInterval>).unref();
    }
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

  async agentReminder(request: AgentReminderOperationRequest, agentApiKey: string) {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("daemon connection is not connected");
    if (!this.agentMessageHttpClient.requestReminder)
      throw new Error("Agent reminder HTTP client is unavailable");
    const response = await this.agentMessageHttpClient.requestReminder({
      url: `${new URL(this.#serverHttpUrl).origin}/api/agent-messages`,
      agentApiKey,
      daemonApiKey: this.#token,
      request,
    });
    for (const field of ["requestId", "workspaceId", "computerId", "agentId"] as const)
      if (response[field] !== request[field])
        throw new Error("uncorrelated Agent reminder response");
    if (response.protocolMajor !== request.protocolMajor)
      throw new Error("uncorrelated Agent reminder response");
    return response;
  }

  async fireReminder(request: ReminderFireRequest): Promise<ReminderFireResponse> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    const reply = await this.#client.rpc(REMINDER_FIRE_METHOD, encodeReminderFireRequest(request));
    return decodeReminderFireResponse(rpcData(reply));
  }

  async requestSnapshot(request: ReminderSnapshotRequest): Promise<ReminderSync> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    const reply = await this.#client.rpc(
      REMINDER_SNAPSHOT_METHOD,
      encodeReminderSnapshotRequest(request),
    );
    return decodeReminderSync(rpcData(reply));
  }

  async agentTask(request: TaskRequest, agentApiKey?: string): Promise<TaskResponse> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    if (!this.#serverHttpUrl) throw new Error("Agent Task HTTP endpoint is not configured");
    return this.agentTaskHttpClient.request({
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
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
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

  #daemonChannel(workspaceId: string, computerId: string): string {
    return `daemon:${workspaceId}:${computerId}`;
  }

  #activityChannel(workspaceId: string): string {
    return `activity:${workspaceId}`;
  }

  #handleAgentPublication(data: Uint8Array, config: DaemonConnectionConfig): void {
    const workspaceId = config.workspaceId;
    try {
      const sync = decodeReminderSync(data);
      if (
        sync.messageType !== REMINDER_SYNC_MESSAGE_TYPE ||
        sync.workspaceId !== workspaceId ||
        sync.computerId !== config.computerId
      )
        throw new Error("reminder sync targets another daemon");
      if (this.#readyPublications) this.#readyPublications.push({ kind: "reminder", value: sync });
      else this.#reminderSyncListener?.(sync);
      return;
    } catch {}
    try {
      const restart = decodeComputerRestartIntent(data);
      if (
        restart.protocolMajor === 1 &&
        restart.workspaceId === workspaceId &&
        restart.computerId === config.computerId &&
        config.requestRestart &&
        !this.#restartRequestIds.has(restart.requestId)
      ) {
        if (this.#restartRequestIds.size >= 256)
          this.#restartRequestIds.delete(this.#restartRequestIds.values().next().value!);
        this.#restartRequestIds.add(restart.requestId);
        try {
          void config.requestRestart(restart.requestId).catch(() => {
            this.#restartRequestIds.delete(restart.requestId);
          });
        } catch (error) {
          this.#restartRequestIds.delete(restart.requestId);
          throw error;
        }
        return;
      }
    } catch {}
    try {
      const request = decodeAgentWorkspaceResetRequest(data);
      if (request.workspaceId === workspaceId) {
        if (this.#readyPublications)
          this.#readyPublications.push({ kind: "workspace-reset", value: request });
        else this.#agentWorkspaceResetListener?.(request);
      }
      return;
    } catch {}
    try {
      const request = decodeAgentSkillsListRequest(data);
      if (request.workspaceId === workspaceId)
        void this.#skillsListListener?.(request).catch(() => {});
      return;
    } catch {}
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
        if (this.#readyPublications)
          this.#readyPublications.push({ kind: "message", value: message });
        else this.#agentMessageListener?.(message);
      } catch {
        try {
          const intent = decodeAgentStopIntent(data);
          if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId)
            throw new Error("agent intent targets another Workspace");
          if (this.#readyPublications)
            this.#readyPublications.push({ kind: "stop", value: intent });
          else this.#agentStopListener?.(intent);
        } catch {
          const intent = decodeAgentStartIntent(data);
          if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId)
            throw new Error("agent intent targets another Workspace");
          if (this.#readyPublications)
            this.#readyPublications.push({ kind: "start", value: intent });
          else this.#agentStartListener?.(intent);
        }
      }
    } catch (error) {
      logger.warning("Rejected invalid Daemon control publication", {
        event: "daemon_control:rejected",
        workspace_id: config.workspaceId,
        computer_id: config.computerId,
        payload_bytes: data.byteLength,
        error_code: diagnosticErrorCode(error),
        outcome: "rejected",
      });
      // Invalid publications are rejected at the protocol boundary and never reach the runtime.
    }
  }

  onAgentWorkspaceReset(callback: (request: AgentWorkspaceResetRequest) => void): () => void {
    this.#agentWorkspaceResetListener = callback;
    return () => {
      if (this.#agentWorkspaceResetListener === callback)
        this.#agentWorkspaceResetListener = undefined;
    };
  }
  onReminderSync(callback: (sync: ReminderSync) => void): () => void {
    this.#reminderSyncListener = callback;
    return () => {
      if (this.#reminderSyncListener === callback) this.#reminderSyncListener = undefined;
    };
  }
  async sendAgentControlResult(result: AgentControlResult) {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    await this.#client.rpc(AGENT_CONTROL_RESULT_METHOD, encodeAgentControlResult(result));
  }
  #skillsListListener: ((request: AgentSkillsListRequest) => Promise<void>) | undefined;
  onSkillsList(callback: (request: AgentSkillsListRequest) => Promise<void>): () => void {
    this.#skillsListListener = callback;
    return () => {
      if (this.#skillsListListener === callback) this.#skillsListListener = undefined;
    };
  }
  async sendSkillsListResult(result: AgentSkillsListResult): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    await this.#client.rpc(AGENT_SKILLS_LIST_RESULT_METHOD, encodeAgentSkillsListResult(result));
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
    const request = createRequest();
    try {
      await this.#sendReady(this.#client, request);
      this.#readyRequestFactory = createRequest;
      logger.info("Daemon ready recovery completed", {
        event: "daemon_ready:completed",
        request_id: request.requestId,
        workspace_id: request.workspaceId,
        computer_id: request.computerId,
        running_agent_count: request.runningAgentIds.length,
        outcome: "ok",
      });
    } catch (error) {
      logger.error("Daemon ready recovery failed", {
        event: "daemon_ready:failed",
        request_id: request.requestId,
        workspace_id: request.workspaceId,
        computer_id: request.computerId,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      throw error;
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

  async reportAgentSession(report: AgentSessionReport): Promise<void> {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    try {
      await this.#client.rpc(AGENT_SESSION_METHOD, encodeAgentSessionReport(report));
    } catch (error) {
      logger.error("Agent session report failed", {
        event: "agent_session:report_failed",
        request_id: report.requestId,
        workspace_id: report.workspaceId,
        computer_id: report.computerId,
        agent_id: report.agentId,
        provider: report.provider,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      throw error;
    }
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
    const request = createRequest();
    try {
      await this.#sendReady(client, request);
    } catch (error) {
      if (client !== this.#client || client !== this.#readyRecoveryClient || !this.#connected)
        return;
      logger.warning("Daemon reconnect recovery will retry", {
        event: "daemon_ready:retry_scheduled",
        request_id: request.requestId,
        workspace_id: request.workspaceId,
        computer_id: request.computerId,
        error_code: diagnosticErrorCode(error),
        retry_delay_ms: RECONNECT_READY_RETRY_MS,
      });
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
    for (const publication of publications) {
      if (publication.kind === "start") this.#agentStartListener?.(publication.value);
      else if (publication.kind === "stop") this.#agentStopListener?.(publication.value);
      else if (publication.kind === "workspace-reset")
        this.#agentWorkspaceResetListener?.(publication.value);
      else if (publication.kind === "reminder") this.#reminderSyncListener?.(publication.value);
      else this.#agentMessageListener?.(publication.value);
    }
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#cancelReadyRecovery();
    if (this.#statusRefreshTimer) clearInterval(this.#statusRefreshTimer);
    this.#statusRefreshTimer = undefined;
    if (this.#computerStatusRefreshTimer !== undefined) {
      if (this.timing.cancelRepeating)
        this.timing.cancelRepeating(this.#computerStatusRefreshTimer);
      else clearInterval(this.#computerStatusRefreshTimer as ReturnType<typeof setInterval>);
      this.#computerStatusRefreshTimer = undefined;
    }
    await this.#statusRpcQueue;
    this.#client = undefined;
    this.#connected = false;
    this.#hasConnected = false;
    this.#agentStartListener = undefined;
    this.#agentStopListener = undefined;
    this.#agentWorkspaceResetListener = undefined;
    this.#agentMessageListener = undefined;
    this.#reminderSyncListener = undefined;
    this.#readyPublications = undefined;
    this.#readyRequestFactory = undefined;
    this.#reconnectListener = undefined;
    this.#pendingActivity.clear();
    this.#supersededActivityLaunches.clear();
    this.#latestStatuses.clear();
    this.#restartRequestIds.clear();
    this.#statusRpcQueue = Promise.resolve();
    client?.disconnect();
  }
}

function diagnosticErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.name : "UnknownError";
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string | undefined): Uint8Array {
  if (!value) throw new Error("missing RPC response payload");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function rpcData(reply: unknown): Uint8Array {
  if (!reply || typeof reply !== "object" || !("data" in reply))
    throw new Error("missing RPC response payload");
  const data = (reply as { data?: unknown }).data;
  if (!(data instanceof Uint8Array)) throw new Error("invalid RPC response payload");
  return data;
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
