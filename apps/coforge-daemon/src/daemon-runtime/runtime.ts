import type { AgentRuntimeConfig, CodeAgentProvider } from "../code-agent/contract";
import { AgentProcessCleanupError } from "../code-agent/contract";
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
  #activityEnabled = false;
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
  readonly #currentActivityLaunches = new Map<
    string,
    { launchId: string; clientSeq: number; stopping: boolean }
  >();
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
      this.#activityEnabled = true;
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
    if (this.#stoppingAgents.has(agentId) || this.#agentProcessManager.isStopping(agentId))
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
    const launch = { launchId: crypto.randomUUID(), clientSeq: 0, stopping: false };
    this.#currentActivityLaunches.set(agentId, launch);
    let agentApiKey: string | undefined;
    let stage: "credential" | "runtime" = "credential";
    try {
      if (!this.#transport.requestAgentApiKey)
        throw new Error("Agent API key endpoint is not configured");
      agentApiKey = await this.#transport.requestAgentApiKey({
        agentId,
        workspaceId: this.#connection.workspaceId,
      });
      this.#pendingAgentApiKeyRevokes.add(agentApiKey);
      if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
      if (this.#stoppingAgents.has(agentId) || this.#agentProcessManager.isStopping(agentId))
        throw new Error(`Agent runtime is stopping: ${agentId}`);
      this.#agentApiKeys.set(agentId, agentApiKey);
      const proxyToken = this.#agentProxy?.issue(agentId, agentApiKey);
      if (proxyToken) this.#agentProxyTokens.set(agentId, proxyToken);
      const localContext = proxyToken ?? this.#contextFor(agentId);
      stage = "runtime";
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
      const emit = (activity: Omit<AgentActivity, "launchId" | "clientSeq" | "occurredAt">) => {
        this.#emitAgentActivity(agentId, launch, activity);
      };
      const unsubscribe = runtime.session.subscribe((runtimeEvent) => {
        if (runtimeEvent.type === "activity") {
          emit({
            protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
            requestId: crypto.randomUUID(),
            workspaceId: this.#connection.workspaceId,
            agentId,
            activity: runtimeEvent.activity.activity,
            level: runtimeEvent.activity.level,
            message: safeRuntimeActivityMessage(
              runtimeEvent.activity.activity,
              runtimeEvent.activity.level,
            ),
          });
          return;
        }
        if (runtimeEvent.type !== "completed") return;
        emit({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: this.#connection.workspaceId,
          agentId,
          activity: "turn_completed",
          level: runtimeEvent.status === "failed" ? "error" : "info",
          message:
            runtimeEvent.status === "failed" ? "Agent turn failed." : "Agent turn completed.",
        });
      });
      runtime.session.onExit(() => {
        if (this.#currentActivityLaunches.get(agentId) !== launch) return;
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
        if (!launch.stopping && this.#currentActivityLaunches.get(agentId) === launch)
          this.#currentActivityLaunches.delete(agentId);
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
      if (!this.#stopping && !this.#stoppingAgents.has(agentId)) {
        this.#emitAgentActivity(agentId, launch, {
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: this.#connection.workspaceId,
          agentId,
          activity: "launch_failed",
          level: "error",
          message: this.#launchFailureMessage(agentId, stage, error),
        });
      }
      if (this.#currentActivityLaunches.get(agentId) === launch)
        this.#currentActivityLaunches.delete(agentId);
      throw error;
    }
  }

  async handleAgentStart(intent: AgentStartIntent): Promise<AgentRuntime> {
    if (intent.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (intent.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent intent targets another Workspace");
    const runtime = await this.startAgent(
      intent.agentId,
      { provider: intent.provider, model: intent.model, reasoning: intent.reasoning },
      intent.sessionId,
    );
    const launch = this.#currentActivityLaunches.get(intent.agentId);
    if (launch)
      this.#emitAgentActivity(intent.agentId, launch, {
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        agentId: intent.agentId,
        activity: "starting",
        level: "info",
        message: "Agent runtime started",
      });
    return runtime;
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
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    if (activityLaunch) activityLaunch.stopping = true;
    this.#revokeLocalLaunch(
      agentId,
      this.#agentContexts.get(agentId),
      this.#agentProxyTokens.get(agentId),
    );
    const stopping = this.#stopAgent(agentId)
      .catch((error) => {
        if (activityLaunch)
          this.#emitAgentActivity(agentId, activityLaunch, {
            protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
            requestId: crypto.randomUUID(),
            workspaceId: this.#connection.workspaceId,
            agentId,
            activity: "stop_failed",
            level: "error",
            message: this.#stopFailureMessage(agentId, error),
          });
        throw error;
      })
      .finally(() => {
        this.#agentStops.delete(agentId);
        if (!this.#agentProcessManager.isStopping(agentId)) this.#stoppingAgents.delete(agentId);
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
    this.#currentActivityLaunches.delete(agentId);
  }

  #revokeLocalLaunch(agentId: string, context?: string, proxyToken?: string): void {
    if (context && this.#agentContexts.get(agentId) === context)
      this.#agentContexts.delete(agentId);
    if (proxyToken && this.#agentProxyTokens.get(agentId) === proxyToken)
      this.#agentProxyTokens.delete(agentId);
    if (proxyToken) this.#agentProxy?.revoke(proxyToken);
  }

  #emitAgentActivity(
    agentId: string,
    launch: { launchId: string; clientSeq: number; stopping: boolean },
    activity: Omit<AgentActivity, "launchId" | "clientSeq" | "occurredAt">,
  ): void {
    if (!this.#activityEnabled || this.#currentActivityLaunches.get(agentId) !== launch) return;
    if (launch.stopping && activity.activity !== "stopped" && activity.level !== "error") return;
    this.#transport.sendAgentActivity?.({
      ...activity,
      launchId: launch.launchId,
      clientSeq: ++launch.clientSeq,
      occurredAt: new Date().toISOString(),
    });
  }

  #launchFailureMessage(agentId: string, stage: "credential" | "runtime", error: unknown): string {
    if (error instanceof AgentProcessCleanupError || this.#agentProcessManager.isStopping(agentId))
      return "Agent process cleanup could not be confirmed. Replacement launch is blocked.";
    return stage === "credential"
      ? "Agent authorization could not be prepared."
      : "Agent runtime could not be started.";
  }

  #stopFailureMessage(agentId: string, error: unknown): string {
    if (error instanceof AgentProcessCleanupError || this.#agentProcessManager.isStopping(agentId))
      return "Agent process cleanup could not be confirmed. Replacement launch is blocked.";
    return "Agent authorization could not be revoked. The Agent process has been stopped.";
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
    this.#activityEnabled = false;
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
    let shutdownError: unknown;
    try {
      await this.#agentProcessManager.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    this.#currentActivityLaunches.clear();
    try {
      await Promise.all(
        [...this.#pendingAgentApiKeyRevokes].map((agentApiKey) =>
          this.#revokeAgentApiKey(agentApiKey),
        ),
      );
    } catch (error) {
      shutdownError ??= error;
    }
    try {
      await this.#transport.stop();
    } catch (error) {
      shutdownError ??= error;
    }
    if (this.#pendingAgentApiKeyRevokes.size === 0) {
      this.#transport = this.#transportFactory.create(this.#connection);
    }
    if (shutdownError !== undefined) throw shutdownError;
  }
}

function safeRuntimeActivityMessage(activity: string, level: string): string {
  if (level === "error") return "Code agent process failed.";
  if (activity === "running_command") return "Agent is running a command.";
  if (activity === "reading_file") return "Agent is reading a file.";
  if (activity === "writing_file") return "Agent is writing a file.";
  if (activity === "editing_file") return "Agent is editing a file.";
  if (activity === "using_tool") return "Agent is using a tool.";
  return "Agent activity observed.";
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
