import type { AgentRuntimeConfig, CodeAgentProvider } from "../code-agent/contract";
import {
  AgentProcessManager,
  type AgentAdapterFactory,
  type AgentRuntime,
} from "../agent-runtime/agent-process-manager";
export type DaemonConfig = {
  workspaceId: string;
  computerId: string;
  workspaceRoot: string;
  serverHttpUrl?: string;
};
/** @deprecated wire-facing callers should use DaemonConfig internally. */
export type WorkspaceConfig = DaemonConfig;
import type { DaemonCredentialStore } from "../credentials/credential-store";
import type {
  WorkspaceCloudTransport,
  WorkspaceCloudTransportFactory,
} from "../cloud-transport/workspace-cloud-transport";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentActivity,
  type AgentStartIntent,
  type AgentMessageDelivery,
} from "@coforge/protocol";
import { agentWorkspaceDirectory } from "../agent-runtime/agent-workspace-path";
import { AgentMessageAttentionIndex } from "./agent-message-attention-index";

export function generateRuntimeInstanceId(): string {
  return crypto.randomUUID();
}

/** The daemon-owned resident runtime for the single configured Workspace. */
export class DaemonRuntime {
  readonly #connection: DaemonConfig;
  readonly #agentProcessManager: AgentProcessManager;
  readonly #credentials: DaemonCredentialStore;
  readonly #transportFactory: WorkspaceCloudTransportFactory;
  #transport: WorkspaceCloudTransport;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopping = false;
  #unsubscribeAgentStart: (() => void) | undefined;
  #unsubscribeAgentMessage: (() => void) | undefined;
  readonly #messageAttention: AgentMessageAttentionIndex;
  readonly #runtimeInstanceId = generateRuntimeInstanceId();
  readonly #startedAt = Date.now();
  readonly #agentContexts = new Map<string, string>();
  readonly #agentProxyTokens = new Map<string, string>();
  readonly #agentApiKeys = new Map<string, string>();
  readonly #agentLaunches = new Map<string, Promise<AgentRuntime>>();
  readonly #stoppingAgents = new Set<string>();
  readonly #agentStops = new Map<string, Promise<void>>();
  readonly #pendingAgentApiKeyRevokes = new Set<string>();
  readonly #agentProxy?: {
    url: string;
    issue(agentId: string, agentApiKey: string): string;
    revoke(token: string): void;
  };

  constructor(
    connection: DaemonConfig,
    createAdapter: AgentAdapterFactory,
    credentials: DaemonCredentialStore,
    transportFactory: WorkspaceCloudTransportFactory,
    agentProxy?: {
      url: string;
      issue(agentId: string, agentApiKey: string): string;
      revoke(token: string): void;
    },
  ) {
    this.#connection = connection;
    this.#agentProcessManager = new AgentProcessManager(createAdapter);
    this.#credentials = credentials;
    this.#transportFactory = transportFactory;
    this.#agentProxy = agentProxy;
    this.#transport = transportFactory.create(connection);
    this.#messageAttention = new AgentMessageAttentionIndex(
      connection.workspaceId,
      this.#agentProcessManager,
      (ack) => this.#transport.sendAgentDeliveryAck?.(ack) ?? Promise.resolve(),
    );
  }

  get agentProcessManager(): AgentProcessManager {
    return this.#agentProcessManager;
  }

  start(connection: DaemonConfig): Promise<void> {
    if (
      connection.workspaceId !== this.#connection.workspaceId ||
      connection.computerId !== this.#connection.computerId
    ) {
      throw new Error("Daemon cannot be started for another Workspace connection");
    }
    if (this.#stopping) return Promise.reject(new Error("daemon runtime is stopping"));
    if (this.#started) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#start(connection).finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  async #start(connection: DaemonConfig): Promise<void> {
    const token = await this.#credentials.load(connection.workspaceId, connection.computerId);
    if (!token) throw new Error("Workspace credential is missing");
    const pending: Array<AgentStartIntent | AgentMessageDelivery> = [];
    let buffering = true;
    const receiveAgentStart = (intent: AgentStartIntent) => {
      if (buffering) {
        pending.push(intent);
        return;
      }
      void this.handleAgentStart(intent).catch(() => {});
    };
    const receiveAgentMessage = (message: AgentMessageDelivery) => {
      if (buffering) {
        pending.push(message);
        return;
      }
      void this.handleAgentMessage(message).catch(() => {});
    };
    try {
      await this.#transport.start(token, {
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        serverHttpUrl: connection.serverHttpUrl,
      });
      this.#unsubscribeAgentStart = this.#transport.onAgentStart?.(receiveAgentStart);
      this.#unsubscribeAgentMessage = this.#transport.onAgentMessage?.(receiveAgentMessage);
      await this.#transport.ready({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        workspaceId: connection.workspaceId,
        // Legacy connection records have no computer identity; the server rejects this.
        computerId: connection.computerId ?? "",
        // Protocol field retained for compatibility with the existing ready handshake.
        workerInstanceId: this.#runtimeInstanceId,
        startedAt: this.#startedAt,
      });
      if (this.#stopping) {
        pending.length = 0;
        return;
      }
      this.#started = true;
      for (const delivery of pending) {
        if ("provider" in delivery) await this.handleAgentStart(delivery).catch(() => {});
        else await this.handleAgentMessage(delivery).catch(() => {});
      }
      pending.length = 0;
      buffering = false;
    } catch (error) {
      this.#unsubscribeAgentStart?.();
      this.#unsubscribeAgentStart = undefined;
      this.#unsubscribeAgentMessage?.();
      this.#unsubscribeAgentMessage = undefined;
      pending.length = 0;
      this.#started = false;
      // A transport may retain partial state after a failed start; never reuse it.
      this.#transport = this.#transportFactory.create(this.#connection);
      throw error;
    }
  }

  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
  ): Promise<AgentRuntime> {
    if (this.#stopping || !this.#started)
      return Promise.reject(new Error("daemon runtime is not running"));
    if (this.#stoppingAgents.has(agentId))
      return Promise.reject(new Error(`Agent runtime is stopping: ${agentId}`));
    const existingLaunch = this.#agentLaunches.get(agentId);
    if (existingLaunch) return existingLaunch;
    if (this.#agentProcessManager.session(agentId))
      return Promise.reject(new Error(`Agent runtime is already online: ${agentId}`));

    // Register the launch before its first await so concurrent starts cannot mint twice.
    const launch = this.#launchAgent(agentId, config, sessionId).finally(() => {
      this.#agentLaunches.delete(agentId);
    });
    this.#agentLaunches.set(agentId, launch);
    return launch;
  }

  async #launchAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
  ): Promise<AgentRuntime> {
    let agentApiKey: string | undefined;
    try {
      if (!this.#transport.requestAgentApiKey)
        throw new Error("Agent API key endpoint is not configured");
      agentApiKey = await this.#transport.requestAgentApiKey({
        agentId,
        workspaceId: this.#connection.workspaceId,
      });
      this.#pendingAgentApiKeyRevokes.add(agentApiKey);
      if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
      if (this.#stoppingAgents.has(agentId))
        throw new Error(`Agent runtime is stopping: ${agentId}`);
      this.#agentApiKeys.set(agentId, agentApiKey);
      const proxyToken = this.#agentProxy?.issue(agentId, agentApiKey);
      if (proxyToken) this.#agentProxyTokens.set(agentId, proxyToken);
      const localContext = proxyToken ?? this.#contextFor(agentId);
      const runtime = await this.#agentProcessManager.start(
        agentId,
        config,
        agentWorkspaceDirectory(
          this.#connection.workspaceRoot,
          this.#connection.workspaceId,
          agentId,
        ),
        sessionId,
        {
          COFORGE_DAEMON_SOCKET: "",
          COFORGE_AGENT_CONTEXT: localContext,
          COFORGE_AGENT_PROXY_URL: this.#agentProxy?.url ?? "",
        },
      );
      if (this.#stoppingAgents.has(agentId)) {
        await this.#agentProcessManager.stop(agentId);
        throw new Error(`Agent runtime is stopping: ${agentId}`);
      }
      const emit = (activity: AgentActivity) => {
        this.#transport.sendAgentActivity?.(activity);
      };
      const unsubscribe = runtime.session.subscribe((runtimeEvent) => {
        emit({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: this.#connection.workspaceId,
          agentId,
          activity: runtimeEvent.type === "completed" ? "turn_completed" : "using_tool",
          level: "info",
          message:
            runtimeEvent.type === "activity"
              ? JSON.stringify(runtimeEvent.activity)
              : runtimeEvent.type === "text-delta"
                ? runtimeEvent.text
                : runtimeEvent.type === "tool-start"
                  ? JSON.stringify({ id: runtimeEvent.id, name: runtimeEvent.name })
                  : runtimeEvent.type === "tool-output"
                    ? JSON.stringify({ id: runtimeEvent.id, text: runtimeEvent.text })
                    : runtimeEvent.type === "tool-end"
                      ? JSON.stringify({ id: runtimeEvent.id, isError: runtimeEvent.isError })
                      : "",
        });
      });
      runtime.session.onExit(() => {
        this.#revokeLocalLaunch(agentId, localContext, proxyToken);
        void this.#revokeAgentApiKey(agentApiKey).catch(() => {
          // Local access is already revoked. Remote failure remains visible
          // through the transport contract and is never treated as success.
        });
        unsubscribe();
        emit({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: this.#connection.workspaceId,
          agentId,
          activity: "stopped",
          level: "info",
          message: "Agent runtime stopped",
        });
      });
      return runtime;
    } catch (error) {
      const proxyToken = this.#agentProxyTokens.get(agentId);
      const localContext = this.#agentContexts.get(agentId);
      this.#revokeLocalLaunch(agentId, localContext, proxyToken);
      if (agentApiKey) {
        try {
          await this.#revokeAgentApiKey(agentApiKey);
        } catch {
          // Keep the plaintext handle in pendingAgentApiKeyRevokes for stop/retry.
        }
      }
      throw error;
    }
  }

  async handleAgentStart(intent: AgentStartIntent): Promise<AgentRuntime> {
    if (intent.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (intent.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent intent targets another Workspace");
    try {
      const runtime = await this.startAgent(
        intent.agentId,
        { provider: intent.provider, model: intent.model, reasoning: intent.reasoning },
        intent.sessionId,
      );
      this.#transport.sendAgentActivity?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        agentId: intent.agentId,
        activity: "starting",
        level: "info",
        message: "Agent runtime started",
      });
      return runtime;
    } catch (error) {
      this.#transport.sendAgentActivity?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        agentId: intent.agentId,
        activity: "error",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async handleAgentMessage(message: AgentMessageDelivery): Promise<void> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    if (message.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (message.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent message targets another Workspace");
    await this.#messageAttention.receive(message);
  }

  stopAgent(agentId: string): Promise<void> {
    const existingStop = this.#agentStops.get(agentId);
    if (existingStop) return existingStop;
    // Close this Agent's launch gate and local capabilities before the first await.
    this.#stoppingAgents.add(agentId);
    this.#revokeLocalLaunch(
      agentId,
      this.#agentContexts.get(agentId),
      this.#agentProxyTokens.get(agentId),
    );
    const stopping = this.#stopAgent(agentId).finally(() => {
      this.#agentStops.delete(agentId);
      this.#stoppingAgents.delete(agentId);
    });
    this.#agentStops.set(agentId, stopping);
    return stopping;
  }

  async #stopAgent(agentId: string): Promise<void> {
    const launch = this.#agentLaunches.get(agentId);
    if (launch) await Promise.allSettled([launch]);
    const results = await Promise.allSettled([
      this.#revokeAgentApiKey(this.#agentApiKeys.get(agentId)),
      this.#agentProcessManager.stop(agentId),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  #revokeLocalLaunch(agentId: string, context?: string, proxyToken?: string): void {
    if (context && this.#agentContexts.get(agentId) === context)
      this.#agentContexts.delete(agentId);
    if (proxyToken && this.#agentProxyTokens.get(agentId) === proxyToken)
      this.#agentProxyTokens.delete(agentId);
    if (proxyToken) this.#agentProxy?.revoke(proxyToken);
  }

  async #revokeAgentApiKey(agentApiKey: string | undefined): Promise<void> {
    if (!agentApiKey) return;
    if (!this.#transport.revokeAgentApiKey) return;
    await this.#transport.revokeAgentApiKey(agentApiKey);
    this.#pendingAgentApiKeyRevokes.delete(agentApiKey);
    for (const [agentId, current] of this.#agentApiKeys)
      if (current === agentApiKey) this.#agentApiKeys.delete(agentId);
  }

  async agentMessage(
    context: string,
    request: import("@coforge/protocol").LocalAgentMessageRequest,
    agentApiKey?: string,
  ): Promise<import("@coforge/protocol").AgentMessageResponse> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    const agentId = [...this.#agentContexts.entries()].find(([, value]) => value === context)?.[0];
    if (!agentId) throw new Error("invalid agent local context");
    if (request.operation === "check") {
      const attention = this.#messageAttention
        .check(agentId)
        .filter((item) => !request.target || item.target === request.target);
      return {
        requestId: request.requestId,
        accepted: true,
        attentionCount: attention.reduce((n, a) => n + a.pendingCount, 0),
        summaries: attention.map((item) => ({ ...item, flags: [...item.flags] })),
        messages: [],
        messageId: "",
      };
    }
    if (!this.#transport.agentMessage) throw new Error("cloud transport is not connected");
    if (!agentApiKey || !/^sk_agent_[A-Za-z0-9_-]{43}$/.test(agentApiKey))
      throw new Error("Agent API key is missing");
    const result = await this.#transport.agentMessage(
      {
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        agentId,
        workspaceId: this.#connection.workspaceId,
        operation: request.operation,
        target: request.target ?? "",
        body: request.body,
      },
      agentApiKey,
    );
    if (request.operation === "read" && result.accepted && request.target)
      this.#messageAttention.clear(agentId, request.target);
    return {
      requestId: request.requestId,
      accepted: result.accepted,
      attentionCount: result.attentionCount,
      messageId: result.messageId ?? "",
      messages: result.messages,
      summaries: [],
    };
  }

  #contextFor(agentId: string): string {
    const context = crypto.randomUUID();
    this.#agentContexts.set(agentId, context);
    return context;
  }

  issueAgentContext(agentId: string, context: string = crypto.randomUUID()): string {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    this.#agentContexts.set(agentId, context);
    return context;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    // Close every local capability synchronously before any shutdown await.
    this.#stopping = true;
    this.#started = false;
    this.#unsubscribeAgentStart?.();
    this.#unsubscribeAgentStart = undefined;
    this.#unsubscribeAgentMessage?.();
    this.#unsubscribeAgentMessage = undefined;
    for (const token of this.#agentProxyTokens.values()) this.#agentProxy?.revoke(token);
    this.#agentProxyTokens.clear();
    this.#agentContexts.clear();
    this.#stopPromise = this.#stop().finally(() => {
      this.#stopPromise = undefined;
      this.#stopping = false;
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
    await Promise.allSettled(this.#agentLaunches.values());
    let transportError: unknown;
    {
      try {
        await Promise.all(
          [...this.#pendingAgentApiKeyRevokes].map((agentApiKey) =>
            this.#revokeAgentApiKey(agentApiKey),
          ),
        );
      } catch (error) {
        transportError = error;
      }
      try {
        await this.#transport.stop();
      } catch (error) {
        transportError ??= error;
      }
      if (this.#pendingAgentApiKeyRevokes.size === 0) {
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

export function createDaemonRuntime(input: {
  createAdapter: AgentAdapterFactory;
  credentials: DaemonCredentialStore;
  transportFactory: WorkspaceCloudTransportFactory;
}): (connection: DaemonConfig) => DaemonRuntime {
  return (connection) =>
    new DaemonRuntime(connection, input.createAdapter, input.credentials, input.transportFactory);
}

export type { AgentAdapterFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
