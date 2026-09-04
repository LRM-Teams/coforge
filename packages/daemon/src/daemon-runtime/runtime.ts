import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  type AgentRuntimeConfig,
  type CodeAgentProvider,
  type UsageSnapshot,
} from "../code-agent/contract";
import { mkdirSync } from "node:fs";
import {
  AgentProcessManager,
  type AgentDriverFactory,
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
  DaemonConnectionClient,
  DaemonConnectionClientFactory,
} from "../connection/daemon-connection";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentActivity,
  type AgentMessageRecord,
  type AgentMessageResponse,
  type AgentStartIntent,
  type AgentMessageDelivery,
  type InboxResponse,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  type RuntimeProvider,
  type UsageScanResponse,
} from "@coforge/protocol";
import { agentWorkspaceDirectory } from "../agent-runtime/agent-workspace-path";
import { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import { AgentMessageDraftStore } from "../persistence/agent-message-draft-store";
import { AgentAppInbox, type MintAppItem } from "../agent-app-inbox/agent-app-inbox";
import { isAgentApiKey } from "../credentials/agent-api-key";
import {
  discoverCodeAgentInventory,
  type CodeAgentInventory,
} from "../code-agent/runtime-inventory";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export function generateRuntimeInstanceId(): string {
  return crypto.randomUUID();
}

/** The daemon-owned resident runtime for the single configured Workspace. */
export class DaemonRuntime {
  readonly #connection: DaemonConfig;
  readonly #createDriver: AgentDriverFactory;
  readonly #agentProcessManager: AgentProcessManager;
  readonly #credentials: DaemonCredentialStore;
  readonly #transportFactory: DaemonConnectionClientFactory;
  #transport: DaemonConnectionClient;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopping = false;
  #activityEnabled = false;
  #unsubscribeAgentStart: (() => void) | undefined;
  #unsubscribeAgentMessage: (() => void) | undefined;
  #unsubscribeReconnect: (() => void) | undefined;
  #unsubscribeUsageScan: (() => void) | undefined;
  readonly #messageAttention: AgentMessageAttentionIndex;
  readonly #agentInboxes = new Map<string, AgentInboxStateMachine>();
  readonly #appInboxes = new Map<string, Promise<AgentAppInbox>>();
  readonly #notifiedAppItems = new Map<string, Set<string>>();
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
  readonly #observedUsage = new Map<CodeAgentProvider, UsageSnapshot>();
  readonly #agentProxy?: {
    url: string;
    issue(agentId: string, agentApiKey: string): string;
    revoke(token: string): void;
  };

  constructor(
    connection: DaemonConfig,
    createDriver: AgentDriverFactory,
    credentials: DaemonCredentialStore,
    transportFactory: DaemonConnectionClientFactory,
    agentProxy?: {
      url: string;
      issue(agentId: string, agentApiKey: string): string;
      revoke(token: string): void;
    },
    private readonly discoverCodeAgents: () => Promise<CodeAgentInventory> = discoverCodeAgentInventory,
    private readonly stateDirectory = ".coforge-daemon-state",
  ) {
    this.#connection = connection;
    this.#createDriver = createDriver;
    this.#agentProcessManager = new AgentProcessManager(createDriver);
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

  async scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse> {
    const protocolMajor = 1;
    if (!this.#started) throw new Error("daemon runtime is not running");
    if (provider !== "codex" && provider !== "claude-code")
      return {
        protocolMajor,
        requestId: "",
        accepted: false,
        status: "unsupported",
        message: "Pi usage scanning is unsupported",
      };
    const driver = this.#createDriver(provider);
    if (!driver.readUsage)
      return { protocolMajor, requestId: "", accepted: false, status: "unsupported" };
    try {
      const directlyReadSnapshot = await driver.readUsage({
        workingDirectory: this.#connection.workspaceRoot,
        timeoutMs: 10_000,
      });
      const snapshot = directlyReadSnapshot ?? this.#currentObservedUsage(provider);
      return snapshot
        ? {
            protocolMajor,
            requestId: "",
            accepted: true,
            status: "available",
            snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
          }
        : {
            protocolMajor,
            requestId: "",
            accepted: false,
            status: "reauth",
            message: "Provider usage is unavailable",
          };
    } catch {
      const snapshot = this.#currentObservedUsage(provider);
      if (snapshot)
        return {
          protocolMajor,
          requestId: "",
          accepted: true,
          status: "available",
          snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
        };
      return {
        protocolMajor,
        requestId: "",
        accepted: false,
        status: "error",
        message: "Usage scan failed",
      };
    }
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
    mkdirSync(connection.workspaceRoot, { recursive: true });
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
      this.#unsubscribeReconnect = this.#transport.onReconnect?.(() => {
        void this.#reportCodeAgents(connection).catch(() => {});
      });
      this.#unsubscribeUsageScan = this.#transport.onUsageScan?.(async (request) => {
        if (request.computerId !== connection.computerId) return;
        const result = await this.scanUsage(request.provider);
        await this.#transport.sendUsageScanResult?.({
          ...result,
          requestId: request.requestId,
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          provider: request.provider,
        });
      });
      // Register publication listeners before the ready RPC. The server may
      // recover persisted Agents immediately as part of that RPC.
      this.#unsubscribeAgentStart = this.#transport.onAgentStart?.(receiveAgentStart);
      this.#unsubscribeAgentMessage = this.#transport.onAgentMessage?.(receiveAgentMessage);
      await this.#transport.start(token, {
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        serverHttpUrl: connection.serverHttpUrl,
      });
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
      await this.#reportCodeAgents(connection).catch(() => {});
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
      this.#unsubscribeUsageScan?.();
      this.#unsubscribeUsageScan = undefined;
      this.#unsubscribeReconnect?.();
      this.#unsubscribeReconnect = undefined;
      pending.length = 0;
      this.#started = false;
      // A transport may retain partial state after a failed start; never reuse it.
      this.#transport = this.#transportFactory.create(this.#connection);
      throw error;
    }
  }

  async #reportCodeAgents(connection: DaemonConfig): Promise<void> {
    const inventory = await this.discoverCodeAgents();
    await this.#transport.updateCodeAgents?.({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      ...inventory,
    });
  }

  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
    requestId: string = crypto.randomUUID(),
  ): Promise<AgentRuntime> {
    if (this.#stopping || !this.#started)
      return Promise.reject(new Error("daemon runtime is not running"));
    if (this.#stoppingAgents.has(agentId) || this.#agentProcessManager.isStopping(agentId))
      return Promise.reject(new Error(`Agent runtime is stopping: ${agentId}`));
    const existingLaunch = this.#agentLaunches.get(agentId);
    if (existingLaunch) return existingLaunch;
    if (this.#agentProcessManager.session(agentId))
      return Promise.reject(new Error(`Agent runtime is already active: ${agentId}`));

    // Register the launch before its first await so concurrent starts cannot mint twice.
    const launch = this.#launchAgent(agentId, config, sessionId, requestId).finally(() => {
      this.#agentLaunches.delete(agentId);
    });
    this.#agentLaunches.set(agentId, launch);
    return launch;
  }

  async #launchAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
    requestId: string = crypto.randomUUID(),
  ): Promise<AgentRuntime> {
    const launch = { launchId: crypto.randomUUID(), clientSeq: 0, stopping: false };
    this.#currentActivityLaunches.set(agentId, launch);
    this.#emitAgentActivity(agentId, launch, {
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId,
      workspaceId: this.#connection.workspaceId,
      agentId,
      activity: "starting",
      level: "info",
      message: "Agent runtime is starting.",
    });
    let agentApiKey: string | undefined;
    let stage: "credential" | "runtime" = "credential";
    try {
      const launchConfig = this.#transport.requestAgentLaunchConfig
        ? await this.#transport.requestAgentLaunchConfig({
            agentId,
            workspaceId: this.#connection.workspaceId,
          })
        : this.#transport.requestAgentApiKey
          ? {
              agentApiKey: await this.#transport.requestAgentApiKey({
                agentId,
                workspaceId: this.#connection.workspaceId,
              }),
            }
          : undefined;
      if (!launchConfig) throw new Error("Agent API key endpoint is not configured");
      agentApiKey = launchConfig.agentApiKey;
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
        {
          ...config,
          ...(launchConfig.providerConfig ? { providerConfig: launchConfig.providerConfig } : {}),
        },
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
        launch.launchId,
      );
      if (this.#stoppingAgents.has(agentId)) {
        await this.#agentProcessManager.stop(agentId);
        throw new Error(`Agent runtime is stopping: ${agentId}`);
      }
      const emit = (activity: Omit<AgentActivity, "launchId" | "clientSeq" | "occurredAt">) => {
        this.#emitAgentActivity(agentId, launch, activity);
      };
      const unsubscribe = runtime.session.subscribe((runtimeEvent) => {
        if (runtimeEvent.type === AGENT_RUNTIME_EVENT_TYPE.USAGE) {
          if (runtimeEvent.snapshot.provider === config.provider)
            this.#rememberUsage(runtimeEvent.snapshot);
          return;
        }
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
              runtimeEvent.activity.message,
            ),
            ...(runtimeEvent.activity.level === "error"
              ? { diagnostic: runtimeFailureDiagnostic(runtimeEvent.activity.message) }
              : runtimeEvent.activity.diagnostic
                ? { diagnostic: runtimeEvent.activity.diagnostic }
                : {}),
          });
          if (runtimeEvent.activity.activity === "idle")
            void this.drainAppInboxNotices(agentId).catch(() => {});
          return;
        }
        if (runtimeEvent.type !== "completed") return;
        emit(
          runtimeEvent.status === "failed"
            ? {
                protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
                requestId: crypto.randomUUID(),
                workspaceId: this.#connection.workspaceId,
                agentId,
                activity: "error",
                level: "error",
                message: "Agent runtime failed.",
                diagnostic: runtimeFailureDiagnostic("turn failure"),
              }
            : {
                protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
                requestId: crypto.randomUUID(),
                workspaceId: this.#connection.workspaceId,
                agentId,
                activity: "turn_completed",
                level: "info",
                message: "Agent turn completed.",
              },
        );
        void this.drainAppInboxNotices(agentId).catch(() => {});
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
      this.#sendAgentStatus(agentId, "active");
      void this.drainAppInboxNotices(agentId).catch(() => {});
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

  #rememberUsage(snapshot: UsageSnapshot): void {
    const current = this.#observedUsage.get(snapshot.provider);
    this.#observedUsage.set(snapshot.provider, {
      ...current,
      ...snapshot,
      primary: snapshot.primary ?? current?.primary,
      secondary: snapshot.secondary ?? current?.secondary,
    });
  }

  #currentObservedUsage(provider: CodeAgentProvider): UsageSnapshot | undefined {
    const snapshot = this.#observedUsage.get(provider);
    if (!snapshot) return undefined;
    const now = Date.now();
    const primary = validUsageWindow(snapshot.primary, now);
    const secondary = validUsageWindow(snapshot.secondary, now);
    if (!primary && !secondary) {
      this.#observedUsage.delete(provider);
      return undefined;
    }
    const current = { ...snapshot, primary, secondary };
    this.#observedUsage.set(provider, current);
    return current;
  }

  async handleAgentStart(intent: AgentStartIntent): Promise<AgentRuntime> {
    if (intent.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (intent.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent intent targets another Workspace");
    if (intent.computerId && intent.computerId !== this.#connection.computerId)
      throw new Error("agent intent targets another Computer");
    return this.startAgent(
      intent.agentId,
      {
        provider: intent.provider,
        model: intent.model,
        modelProvider: intent.modelProvider,
        reasoning: intent.reasoning,
        providerConfig: intent.providerConfig,
      },
      intent.sessionId,
      intent.requestId,
    );
  }

  async handleAgentMessage(message: AgentMessageDelivery): Promise<void> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    if (this.#stoppingAgents.has(message.agentId))
      throw new Error(`Agent runtime is stopping: ${message.agentId}`);
    if (message.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (message.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent message targets another Workspace");
    if (!this.#agentProcessManager.session(message.agentId)) {
      const wakeable = this.#agentProcessManager.restartConfig(message.agentId);
      if (!wakeable) throw new Error("Agent is inactive");
      await this.startAgent(message.agentId, wakeable.config, wakeable.sessionId);
    }
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
    this.#messageAttention.clearAgent(agentId);
    this.#sendAgentStatus(agentId, "inactive");
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

  #sendAgentStatus(agentId: string, status: "active" | "inactive"): void {
    this.#transport.sendAgentStatus?.({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
      agentId,
      status,
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
    request: LocalAgentMessageRequest,
    agentApiKey?: string,
  ): Promise<AgentMessageResponse> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    const agentId = [...this.#agentContexts.entries()].find(([, value]) => value === context)?.[0];
    if (!agentId) throw new Error("invalid agent local context");
    if (request.operation === "check") {
      const startedAt = performance.now();
      const attention = this.#messageAttention
        .check(agentId)
        .filter((item) => !request.target || item.target === request.target);
      if (!this.#transport.agentMessage) throw new Error("daemon connection is not connected");
      if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
      const messages: AgentMessageRecord[] = [];
      for (const item of attention) {
        const result = await this.#transport.agentMessage(
          {
            protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
            requestId: request.requestId,
            agentId,
            workspaceId: this.#connection.workspaceId,
            operation: "read",
            target: item.target,
            before: request.before,
            after: request.after,
            around: request.around,
            limit: request.limit,
          },
          agentApiKey,
        );
        if (!result.accepted) continue;
        messages.push(
          ...result.messages.filter(
            ({ sequence }) =>
              sequence >= item.firstPendingSequence && sequence <= item.latestSequence,
          ),
        );
        const visibleSequence = Math.max(
          0,
          ...result.messages
            .filter(
              ({ sequence }) =>
                sequence >= item.firstPendingSequence && sequence <= item.latestSequence,
            )
            .map(({ sequence }) => sequence),
        );
        if (visibleSequence > 0)
          this.#messageAttention.recordModelSeen(agentId, item.target, visibleSequence);
      }
      logger.info("Agent checked pending messages", {
        event: "agent.message.checked",
        request_id: request.requestId,
        workspace_id: this.#connection.workspaceId,
        computer_id: this.#connection.computerId,
        agent_id: agentId,
        target_count: attention.length,
        pending_count: attention.reduce((count, item) => count + item.pendingCount, 0),
        displayed_count: messages.length,
        sequence_ranges: attention.map((item) => ({
          first: item.firstPendingSequence,
          latest: item.latestSequence,
        })),
        duration_ms: Math.round(performance.now() - startedAt),
        outcome: "ok",
      });
      return {
        requestId: request.requestId,
        accepted: true,
        attentionCount: attention.reduce((n, a) => n + a.pendingCount, 0),
        summaries: attention.map((item) => ({ ...item, flags: [...item.flags] })),
        messages,
        messageId: "",
      };
    }
    if (!this.#transport.agentMessage) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    if (request.operation === "send" && request.target) {
      const startedAt = performance.now();
      const inbox = this.#agentInbox(agentId);
      const draft = request.sendDraft ? await inbox.draft(request.target) : undefined;
      if (request.sendDraft && !draft)
        throw new Error(`No held draft for target: ${request.target}`);
      const body = draft?.body ?? request.body;
      if (body === undefined) throw new Error("Agent message body is required");
      if (!request.sendDraft) await inbox.save(request.target, body);
      if (request.sendDraft && !draft?.holdToken)
        throw new Error(`Held draft token is unavailable for target: ${request.target}`);
      const result = await this.#transport.agentMessage(
        {
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: request.requestId,
          agentId,
          workspaceId: this.#connection.workspaceId,
          operation: "send",
          target: request.target,
          body,
          holdToken: draft?.holdToken,
          continueAnyway: request.continueAnyway,
        },
        agentApiKey,
      );
      if (result.sideEffectDecision === "hold" && result.holdToken)
        await inbox.replace(request.target, body, result.holdToken);
      else if (result.accepted) await inbox.clear(request.target);
      if (result.messages.length > 0) {
        this.#messageAttention.recordModelSeen(
          agentId,
          request.target,
          Math.max(...result.messages.map(({ sequence }) => sequence)),
        );
      }
      if (result.sideEffectDecision === "hold") {
        const launch = this.#currentActivityLaunches.get(agentId);
        if (launch)
          this.#emitAgentActivity(agentId, launch, {
            protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
            requestId: crypto.randomUUID(),
            workspaceId: this.#connection.workspaceId,
            agentId,
            activity: "freshness_hold",
            level: "info",
            message: "Reply held until the Agent reviews newer messages.",
          });
      }
      logger.info("Agent sent a message", {
        event: "agent.message.sent",
        request_id: request.requestId,
        workspace_id: this.#connection.workspaceId,
        computer_id: this.#connection.computerId,
        agent_id: agentId,
        freshness_decision: result.sideEffectDecision ?? "forward",
        accepted: result.accepted,
        message_id: result.messageId,
        duration_ms: Math.round(performance.now() - startedAt),
        outcome: result.accepted ? "ok" : "rejected",
      });
      return {
        requestId: request.requestId,
        accepted: result.accepted,
        attentionCount: result.attentionCount,
        messageId: result.messageId ?? "",
        messages: result.messages,
        summaries: [],
        sideEffectDecision:
          result.sideEffectDecision === "anyway_accepted"
            ? "bypass"
            : result.sideEffectDecision === "anyway_denied"
              ? undefined
              : result.sideEffectDecision,
        anywayAllowed: result.anywayAllowed,
      };
    }
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
    if (request.operation === "read" && result.accepted && request.target) {
      const visibleSequence = Math.max(...result.messages.map(({ sequence }) => sequence), 0);
      if (visibleSequence > 0)
        this.#messageAttention.recordModelSeen(agentId, request.target, visibleSequence);
      else this.#messageAttention.clear(agentId, request.target);
    }
    return {
      requestId: request.requestId,
      accepted: result.accepted,
      attentionCount: result.attentionCount,
      messageId: result.messageId ?? "",
      messages: result.messages,
      summaries: [],
    };
  }

  async mintAppItem(agentId: string, input: MintAppItem) {
    const item = await (await this.#appInbox(agentId)).upsert(input);
    await this.#notifyAppItem(agentId, item.itemId);
    return item;
  }

  async inbox(context: string, request: LocalInboxRequest): Promise<InboxResponse> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    const agentId = this.#agentIdForContext(context);
    const inbox = await this.#appInbox(agentId);
    return {
      requestId: request.requestId,
      accepted: true,
      entries: [
        ...this.#messageAttention.check(agentId).map((messageTarget) => ({
          kind: "message_target" as const,
          messageTarget: { ...messageTarget, flags: [...messageTarget.flags] },
        })),
        ...inbox.list().map((app) => ({ kind: "app" as const, app })),
      ],
    };
  }

  async drainAppInboxNotices(agentId: string): Promise<void> {
    for (const item of (await this.#appInbox(agentId)).list())
      await this.#notifyAppItem(agentId, item.itemId);
  }

  #appInbox(agentId: string): Promise<AgentAppInbox> {
    const existing = this.#appInboxes.get(agentId);
    if (existing) return existing;
    const opened = AgentAppInbox.open(this.stateDirectory, this.#connection.workspaceId, agentId);
    this.#appInboxes.set(agentId, opened);
    return opened;
  }

  #agentInbox(agentId: string): AgentInboxStateMachine {
    const existing = this.#agentInboxes.get(agentId);
    if (existing) return existing;
    const inbox = new AgentInboxStateMachine(new AgentMessageDraftStore(agentId));
    this.#agentInboxes.set(agentId, inbox);
    return inbox;
  }

  async #notifyAppItem(agentId: string, itemId: string): Promise<void> {
    const notified = this.#notifiedAppItems.get(agentId) ?? new Set<string>();
    this.#notifiedAppItems.set(agentId, notified);
    if (notified.has(itemId)) return;
    let session = this.#agentProcessManager.session(agentId);
    if (!session) {
      const wakeable = this.#agentProcessManager.restartConfig(agentId);
      if (!wakeable) return;
      session = (await this.startAgent(agentId, wakeable.config, wakeable.sessionId)).session;
    }
    if (!session.notify || notified.has(itemId)) return;
    notified.add(itemId);
    try {
      await session.notify("New app item available. Run coforge inbox check.");
    } catch (error) {
      notified.delete(itemId);
      throw error;
    }
  }

  #agentIdForContext(context: string): string {
    const agentId = [...this.#agentContexts.entries()].find(([, value]) => value === context)?.[0];
    if (!agentId) throw new Error("invalid agent local context");
    return agentId;
  }

  async agentAttachment(
    context: string,
    attachmentId: string,
    agentApiKey?: string,
  ): Promise<Response> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    const agentId = [...this.#agentContexts.entries()].find(([, value]) => value === context)?.[0];
    if (!agentId) throw new Error("invalid agent local context");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    if (!this.#transport.agentAttachment) throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachment(attachmentId, agentApiKey);
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
    this.#unsubscribeUsageScan?.();
    this.#unsubscribeUsageScan = undefined;
    this.#unsubscribeReconnect?.();
    this.#unsubscribeReconnect = undefined;
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
    const activeAgentIds = this.#agentProcessManager.activeAgentIds();
    let shutdownError: unknown;
    try {
      await this.#agentProcessManager.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    for (const agentId of activeAgentIds) this.#sendAgentStatus(agentId, "inactive");
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

function safeRuntimeActivityMessage(activity: string, level: string, message: string): string {
  if (level === "error" || level === "warning") return scrubActivityText(message);
  if (activity === "running_command") return [...scrubActivityText(message)].slice(0, 100).join("");
  if (
    activity === "reading_file" ||
    activity === "writing_file" ||
    activity === "editing_file" ||
    activity === "using_tool"
  ) {
    return scrubActivityText(message);
  }
  return "Agent activity observed.";
}

function scrubActivityText(message: string): string {
  return message
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 512);
}

function runtimeFailureDiagnostic(message: string) {
  const safe = scrubActivityText(message);
  let hash = 2166136261;
  for (const character of safe) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return {
    errorClass: "AgentRuntimeError",
    reason: "runtime_failure",
    fingerprint: (hash >>> 0).toString(16).padStart(8, "0"),
  };
}

function validUsageWindow(window: UsageSnapshot["primary"], now: number): UsageSnapshot["primary"] {
  return window && Date.parse(window.resetsAt) > now ? window : undefined;
}

export function createDaemonRuntime(input: {
  createDriver: AgentDriverFactory;
  credentials: DaemonCredentialStore;
  transportFactory: DaemonConnectionClientFactory;
}): (connection: DaemonConfig) => DaemonRuntime {
  return (connection) =>
    new DaemonRuntime(connection, input.createDriver, input.credentials, input.transportFactory);
}

export type { AgentDriverFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
