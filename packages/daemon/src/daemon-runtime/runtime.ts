import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  UsageUnavailableError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type UsageSnapshot,
} from "../code-agent/contract";
import { mkdirSync } from "node:fs";
import { readOperatingSystem } from "../platform/operating-system";
import { ActivityTrajectory } from "../agent-runtime/activity-trajectory";
import {
  AgentProcessManager,
  type CodeAgentProviderFactory,
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
  TASK_PROTOCOL_MAJOR,
  AGENT_ACTIVITY_DETAIL_KIND,
  isChannelMessageTarget,
  type AgentActivity,
  type AgentMessageRecord,
  type AgentMessageResponse,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  type AgentStartIntent,
  type AgentStopIntent,
  type AgentWorkspaceResetRequest,
  type AgentMessageDelivery,
  type InboxResponse,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  type RuntimeProvider,
  type UsageScanResponse,
  REMINDER_CAPABILITY,
  type AgentReminderOperationRequest,
  type LocalReminderRequest,
  type ReminderJob,
  type ReminderSync,
  type TaskCommand,
  type TaskResult,
} from "@lrm/coforge-sdk/internal";
import { agentWorkspaceDirectory } from "../agent-runtime/agent-workspace-path";
import { AgentControl } from "../agent-runtime/agent-control";
import { AgentSessions } from "../agent-runtime/agent-session";
import { AgentRuntimeState } from "../agent-runtime/agent-runtime-state";
import { FileAgentRuntimeStateStore } from "../persistence/agent-runtime-state-store";
import { listAgentSkills } from "../code-agent/agent-skills";
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
import { COFORGE_DAEMON_VERSION } from "../version";
import { ReminderScheduler, reminderAppInboxPreview } from "../agent-reminder/reminder-scheduler";
import { FileReminderReceiptStore } from "../persistence/reminder-receipt-store";
import { diagnosticErrorCode } from "../platform/diagnostic-error-code";

const logger = getLogger(["coforge", "daemon", "runtime"]);
const FULL_THREAD_TARGET =
  /^((?:@[^:]+)|(?:#[a-z0-9][a-z0-9_-]{0,31})):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SHORT_THREAD_TARGET = /^((?:@[^:]+)|(?:#[a-z0-9][a-z0-9_-]{0,31})):([0-9a-f]{8})$/;
const NOT_RUNNING = "daemon runtime is not running";
const CLEANUP_UNCONFIRMED =
  "Agent process cleanup could not be confirmed. Replacement launch is blocked.";

type AgentInputCompletion = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type AgentRecoveryContext = Pick<
  AgentStartIntent,
  "wakeMessage" | "resumeMessages" | "unreadSummary"
>;

type AgentInput =
  | { kind: "recovery"; context: AgentRecoveryContext; completion: AgentInputCompletion }
  | { kind: "delivery"; message: AgentMessageDelivery; completion: AgentInputCompletion };

type AgentInputQueue = {
  items: AgentInput[];
  drain?: Promise<void>;
  closed: boolean;
};

type ActivityLaunch = { launchId: string; clientSeq: number; stopping: boolean };

/** An activity envelope before the launch assigns its sequence metadata. */
type ActivityDraft = Omit<AgentActivity, "launchId" | "clientSeq" | "observedAtMs">;

type SessionMode = "create" | "resume";

/** Cloud-supplied identity for one launch; every field falls back to the previous reference. */
type LaunchRequest = {
  sessionId?: string;
  requestId?: string;
  previousLaunchId?: string;
  sessionMode?: SessionMode;
  control?: { controlEpoch?: number; launchId: string };
  replacedSessionId?: string;
};

type AgentProxy = {
  url: string;
  issue(agentId: string, agentApiKey: string): string;
  revoke(token: string): void;
};

export function generateRuntimeInstanceId(): string {
  return crypto.randomUUID();
}

function runtimeConfigOf(intent: AgentStartIntent): AgentRuntimeConfig {
  return {
    provider: intent.provider,
    model: intent.model,
    modelProvider: intent.modelProvider,
    reasoning: intent.reasoning,
    providerConfig: intent.providerConfig,
  };
}

function recoveryOf(intent: AgentStartIntent): AgentRecoveryContext {
  return {
    wakeMessage: intent.wakeMessage,
    resumeMessages: intent.resumeMessages,
    unreadSummary: intent.unreadSummary,
  };
}

/** A daemon-owned resident runtime for one supervised Workspace. */
export class DaemonRuntime {
  readonly #connection: DaemonConfig;
  readonly #createProvider: CodeAgentProviderFactory;
  readonly #agentProcessManager: AgentProcessManager;
  readonly #credentials: DaemonCredentialStore;
  readonly #transportFactory: DaemonConnectionClientFactory;
  #transport: DaemonConnectionClient;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopping = false;
  #activityEnabled = false;
  #subscriptions: Array<() => void> = [];
  readonly #agentControl: AgentControl;
  readonly #agentSessions: AgentSessions;
  #skillsScanning = false;
  readonly #messageAttention: AgentMessageAttentionIndex;
  readonly #reminders: ReminderScheduler;
  readonly #agentInboxes = new Map<string, AgentInboxStateMachine>();
  readonly #appInboxes = new Map<string, Promise<AgentAppInbox>>();
  readonly #notifiedAppItems = new Map<string, Map<string, Promise<boolean>>>();
  readonly #runtimeInstanceId = generateRuntimeInstanceId();
  readonly #startedAt = Date.now();
  readonly #agentContexts = new Map<string, string>();
  readonly #agentProxyTokens = new Map<string, string>();
  readonly #agentApiKeys = new Map<string, string>();
  readonly #agentLaunches = new Map<string, Promise<AgentRuntime>>();
  readonly #sessionReferences = new Map<
    string,
    {
      requestId: string;
      provider: AgentRuntimeConfig["provider"];
      sessionId?: string;
      sessionMode?: SessionMode;
      launchId?: string;
    }
  >();
  readonly #agentInputQueues = new Map<string, AgentInputQueue>();
  readonly #stoppingAgents = new Set<string>();
  readonly #agentStops = new Map<string, Promise<void>>();
  readonly #currentActivityLaunches = new Map<string, ActivityLaunch>();
  readonly #agentStatusSequences = new Map<string, number>();
  readonly #pendingAgentApiKeyRevokes = new Set<string>();
  readonly #observedUsage = new Map<RuntimeProvider, UsageSnapshot>();
  readonly #agentProxy?: AgentProxy;

  constructor(
    connection: DaemonConfig,
    createProvider: CodeAgentProviderFactory,
    credentials: DaemonCredentialStore,
    transportFactory: DaemonConnectionClientFactory,
    agentProxy?: AgentProxy,
    private readonly discoverCodeAgents: () => Promise<CodeAgentInventory> = discoverCodeAgentInventory,
    private readonly stateDirectory = ".coforge-daemon-state",
    private readonly lifecycle: {
      requestRestart?(requestId: string): Promise<void>;
      requestUpgrade?(requestId: string, expectedVersion?: string): Promise<void>;
      recoveredRestartRequestIds?: string[];
      recoveredUpgradeRequestIds?: string[];
    } = {},
    private readonly computerVersion?: string,
  ) {
    this.#connection = connection;
    this.#createProvider = createProvider;
    this.#agentProcessManager = new AgentProcessManager(createProvider);
    this.#credentials = credentials;
    this.#transportFactory = transportFactory;
    this.#agentProxy = agentProxy;
    this.#transport = transportFactory.create(connection);
    this.#messageAttention = new AgentMessageAttentionIndex(
      connection.workspaceId,
      this.#agentProcessManager,
      (ack) => this.#transport.sendAgentDeliveryAck?.(ack) ?? Promise.resolve(),
      (agentId) => {
        try {
          this.#emitCurrentActivity(
            agentId,
            this.#activity(
              agentId,
              AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
              "info",
              "Message received",
              {
                entries: [],
              },
            ),
          );
        } catch {
          // Best-effort observation must not turn accepted input into failed delivery.
        }
      },
    );
    this.#reminders = new ReminderScheduler(
      { workspaceId: connection.workspaceId, computerId: connection.computerId },
      new FileReminderReceiptStore(stateDirectory, connection.workspaceId, connection.computerId),
      (request) => {
        if (!this.#transport.fireReminder) throw new Error("reminder fire is unavailable");
        return this.#transport.fireReminder(request);
      },
      (job) => this.#acceptReminderDue(job),
    );
    const state = new AgentRuntimeState(
      new FileAgentRuntimeStateStore(
        stateDirectory,
        connection.workspaceRoot,
        connection.workspaceId,
      ),
    );
    this.#agentSessions = new AgentSessions(state, async (snapshot) => {
      await this.#transport.reportAgentSession?.({
        protocolMajor: snapshot.protocolMajor,
        requestId: crypto.randomUUID(),
        workspaceId: snapshot.workspaceId,
        computerId: snapshot.computerId,
        agentId: snapshot.agentId,
        provider: snapshot.provider,
        startRequestId: snapshot.requestId,
        daemonInstanceId: snapshot.daemonInstanceId ?? this.#runtimeInstanceId,
        launchId: snapshot.launchId,
        sessionId: snapshot.identity.sessionId,
        sessionState: snapshot.identity.state,
        controlEpoch: snapshot.epoch,
        sequence: snapshot.sequence,
      });
    });
    this.#agentControl = new AgentControl(this.#runtimeInstanceId, state, this.#agentSessions, {
      running: (agentId) => Boolean(this.#agentProcessManager.session(agentId)),
      stop: async (agentId) => {
        const session = this.#agentProcessManager.session(agentId);
        await this.stopAgent(agentId);
        return session?.readSessionIdentity?.();
      },
      launch: async (intent, launchId, replacedSessionId) => {
        if (replacedSessionId) this.#sessionReferences.delete(intent.agentId);
        const runtime = await this.#startAgent(
          intent.agentId,
          runtimeConfigOf(intent),
          recoveryOf(intent),
          {
            sessionId: intent.sessionId,
            requestId: intent.requestId,
            previousLaunchId: intent.previousLaunchId,
            sessionMode: intent.sessionMode,
            control: { controlEpoch: intent.controlEpoch, launchId },
            replacedSessionId,
          },
        );
        return runtime.session.readSessionIdentity?.();
      },
      wake: async (intent) => {
        await this.#startAgent(
          intent.agentId,
          runtimeConfigOf(intent),
          { wakeMessage: intent.wakeMessage },
          { requestId: intent.requestId },
        );
      },
      result: async (result) => {
        await this.#transport.sendAgentControlResult?.(result);
      },
    });
  }

  get agentProcessManager(): AgentProcessManager {
    return this.#agentProcessManager;
  }

  #assertRunning(): void {
    if (this.#stopping || !this.#started) throw new Error(NOT_RUNNING);
  }

  #assertAgentNotStopping(agentId: string): void {
    if (this.#stoppingAgents.has(agentId) || this.#agentProcessManager.isStopping(agentId))
      throw new Error(`Agent runtime is stopping: ${agentId}`);
  }

  /** Resolves the Agent behind a local context and checks its API key; the transport is checked by the caller. */
  #authorizedAgent(context: string, agentApiKey: string | undefined): string {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    return agentId;
  }

  async scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse> {
    this.#assertRunning();
    const result = (
      status: UsageScanResponse["status"],
      snapshot?: UsageSnapshot,
      message?: string,
    ): UsageScanResponse => ({
      protocolMajor: 1,
      requestId: "",
      accepted: Boolean(snapshot),
      status,
      ...(snapshot ? { snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)) } : {}),
      ...(message ? { message } : {}),
    });
    if (provider !== "codex" && provider !== "claude-code" && provider !== "kiro")
      return result("unsupported", undefined, "Pi usage scanning is unsupported");
    const codeAgentProvider = this.#createProvider(provider);
    if (!codeAgentProvider.readUsage) return result("unsupported");
    try {
      const snapshot =
        (await codeAgentProvider.readUsage({
          workingDirectory: this.#connection.workspaceRoot,
          timeoutMs: 10_000,
        })) ?? this.#currentObservedUsage(provider);
      return snapshot
        ? result("available", snapshot)
        : result("reauth", undefined, "Provider usage is unavailable");
    } catch (error) {
      const snapshot = this.#currentObservedUsage(provider);
      if (snapshot) return result("available", snapshot);
      return error instanceof UsageUnavailableError
        ? result("unavailable", undefined, "Provider usage is unavailable")
        : result("error", undefined, "Usage scan failed");
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

  #subscribe(unsubscribe: (() => void) | undefined): void {
    if (unsubscribe) this.#subscriptions.push(unsubscribe);
  }

  #unsubscribeAll(): void {
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
  }

  async #start(connection: DaemonConfig): Promise<void> {
    mkdirSync(connection.workspaceRoot, { recursive: true });
    await this.#agentControl.initialize();
    const token = await this.#credentials.load(connection.workspaceId, connection.computerId);
    if (!token) throw new Error("Workspace credential is missing");
    // Publications that arrive before the ready handshake completes are replayed afterwards:
    // control intents first, in arrival order, then Message deliveries.
    const pendingControl: Array<() => Promise<void>> = [];
    const pendingMessages: Array<() => Promise<void>> = [];
    let buffering = true;
    const receive =
      <Value>(queue: Array<() => Promise<void>>, handle: (value: Value) => Promise<void>) =>
      (value: Value) => {
        if (buffering) queue.push(() => handle(value));
        else void handle(value);
      };
    const failure =
      <Request extends AgentStopIntent | AgentWorkspaceResetRequest | AgentMessageDelivery>(
        operation: "stop" | "workspace_reset" | "message_delivery",
        handle: (request: Request) => Promise<void>,
      ) =>
      (request: Request) =>
        handle(request).catch((error) => this.#logAgentOperationFailure(operation, request, error));
    try {
      this.#subscribe(
        this.#transport.onReconnect?.(() => {
          void this.#reportCodeAgents(connection).catch(() => {});
          for (const agentId of this.#readyRunningAgentIds())
            void this.#requestReminderSnapshot(agentId).catch(() => {});
          void this.#agentControl
            .replay()
            .then(() => this.#agentSessions.replay())
            .catch((error) => {
              logger.warning("Agent control recovery replay failed", {
                event: "agent_control:replay_failed",
                workspace_id: connection.workspaceId,
                computer_id: connection.computerId,
                error_code: diagnosticErrorCode(error),
                outcome: "failed",
              });
            });
        }),
      );
      const transport = this.#transport;
      this.#subscribe(
        transport.onSkillsList?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          const result = await this.#listAgentSkills(connection, request);
          if (!this.#stopping && this.#transport === transport)
            await transport.sendSkillsListResult?.({
              ...request,
              ...result,
              scannedAtMs: Date.now(),
            });
        }),
      );
      this.#subscribe(
        this.#transport.onUsageScan?.(async (request) => {
          if (request.computerId !== connection.computerId) return;
          const result = await this.scanUsage(request.provider);
          await this.#transport.sendUsageScanResult?.({
            ...result,
            requestId: request.requestId,
            workspaceId: connection.workspaceId,
            computerId: connection.computerId,
            provider: request.provider,
          });
        }),
      );
      // Register publication listeners before the ready RPC. The server may
      // recover persisted Agents immediately as part of that RPC.
      this.#subscribe(
        this.#transport.onAgentStart?.(
          receive(pendingControl, (intent: AgentStartIntent) =>
            this.handleAgentStart(intent).then(
              () => {},
              (error) => this.#logAgentStartFailure(intent, error),
            ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentStop?.(
          receive(
            pendingControl,
            failure("stop", (intent: AgentStopIntent) => this.handleAgentStop(intent)),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentWorkspaceReset?.(
          receive(
            pendingControl,
            failure("workspace_reset", (request: AgentWorkspaceResetRequest) =>
              this.handleAgentWorkspaceReset(request),
            ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentMessage?.(
          receive(
            pendingMessages,
            failure("message_delivery", (message: AgentMessageDelivery) =>
              this.handleAgentMessage(message),
            ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onReminderSync?.((sync) => {
          void this.#reminders.apply(sync).catch(() => {});
        }),
      );
      await this.#transport.start(token, {
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        serverHttpUrl: connection.serverHttpUrl,
        requestRestart: this.lifecycle.requestRestart,
        requestUpgrade: this.lifecycle.requestUpgrade,
      });
      await this.#agentControl.replay();
      await this.#agentSessions.replay();
      await this.#transport.ready(() => ({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        workspaceId: connection.workspaceId,
        // Legacy connection records have no computer identity; the server rejects this.
        computerId: connection.computerId ?? "",
        // Protocol field retained for compatibility with the existing ready handshake.
        workerInstanceId: this.#runtimeInstanceId,
        startedAt: this.#startedAt,
        runningAgentIds: this.#readyRunningAgentIds(),
        daemonVersion: COFORGE_DAEMON_VERSION,
        computerVersion: this.computerVersion,
        ...readOperatingSystem(),
        recoveredRestartRequestIds: this.lifecycle.recoveredRestartRequestIds ?? [],
        recoveredUpgradeRequestIds: this.lifecycle.recoveredUpgradeRequestIds ?? [],
        capabilities: [REMINDER_CAPABILITY],
      }));
      await Promise.all(
        this.#readyRunningAgentIds().map((agentId) => this.#requestReminderSnapshot(agentId)),
      );
      await this.#reportCodeAgents(connection).catch(() => {});
      if (this.#stopping) return;
      const buffered = [...pendingControl.splice(0), ...pendingMessages.splice(0)];
      buffering = false;
      this.#started = true;
      this.#activityEnabled = true;
      await Promise.all(buffered.map((flush) => flush()));
    } catch (error) {
      this.#unsubscribeAll();
      this.#started = false;
      // A transport may retain partial state after a failed start; never reuse it.
      this.#transport = this.#transportFactory.create(this.#connection);
      throw error;
    }
  }

  async #listAgentSkills(
    connection: DaemonConfig,
    request: { agentId: string; provider: RuntimeProvider },
  ): Promise<Awaited<ReturnType<typeof listAgentSkills>>> {
    const unavailable = { status: "error" as const, entries: [], directories: [] };
    const config = this.#agentProcessManager.runtime(request.agentId)?.config;
    if (this.#skillsScanning || (config && config.provider !== request.provider))
      return { global: unavailable, workspace: unavailable };
    this.#skillsScanning = true;
    try {
      // Launch only adds COFORGE_* capabilities to agentEnvironment;
      // it does not override HOME or provider-native config roots.
      return await listAgentSkills({
        provider: request.provider,
        agentWorkspaceDirectory: agentWorkspaceDirectory(
          connection.workspaceRoot,
          connection.workspaceId,
          request.agentId,
        ),
      });
    } catch {
      // Return safe diagnostics, never file contents or raw filesystem errors.
      return { global: unavailable, workspace: unavailable };
    } finally {
      this.#skillsScanning = false;
    }
  }

  async #reportCodeAgents(connection: DaemonConfig): Promise<void> {
    const requestId = crypto.randomUUID();
    const scope = {
      request_id: requestId,
      workspace_id: connection.workspaceId,
      computer_id: connection.computerId,
    };
    try {
      const inventory = await this.discoverCodeAgents();
      await this.#transport.updateCodeAgents?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        ...inventory,
      });
      logger.info("Code Agent inventory reported", {
        event: "code_agent_inventory:reported",
        ...scope,
        runtime_count: inventory.runtimes.length,
        catalog_count: inventory.catalogs.length,
        outcome: "ok",
      });
    } catch (error) {
      logger.warning("Code Agent inventory report failed", {
        event: "code_agent_inventory:report_failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      throw error;
    }
  }

  #logAgentStartFailure(intent: AgentStartIntent, error: unknown): void {
    logger.error("Agent runtime start failed", {
      event: "agent_runtime:start_failed",
      request_id: intent.requestId,
      workspace_id: intent.workspaceId,
      computer_id: intent.computerId,
      agent_id: intent.agentId,
      provider: intent.provider,
      error_code: diagnosticErrorCode(error),
      outcome: "failed",
    });
  }

  #logAgentOperationFailure(
    operation: "stop" | "workspace_reset" | "message_delivery",
    request: AgentStopIntent | AgentWorkspaceResetRequest | AgentMessageDelivery,
    error: unknown,
  ): void {
    logger.warning("Daemon Agent operation failed", {
      event: `agent_runtime:${operation}_failed`,
      request_id: request.requestId,
      workspace_id: request.workspaceId,
      computer_id: this.#connection.computerId,
      agent_id: request.agentId,
      error_code: diagnosticErrorCode(error),
      outcome: "failed",
    });
  }

  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
    requestId?: string,
    recovery?: AgentRecoveryContext,
    previousLaunchId?: string,
    sessionMode?: SessionMode,
    control?: { controlEpoch?: number; launchId: string },
    replacedSessionId?: string,
  ): Promise<AgentRuntime> {
    return this.#startAgent(agentId, config, recovery, {
      sessionId,
      requestId,
      previousLaunchId,
      sessionMode,
      control,
      replacedSessionId,
    });
  }

  #startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    recovery: AgentRecoveryContext | undefined,
    request: LaunchRequest,
  ): Promise<AgentRuntime> {
    try {
      this.#assertRunning();
      this.#assertAgentNotStopping(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
    const enqueueRecovery = (context: AgentRecoveryContext) =>
      this.#enqueueAgentInput(agentId, (completion) => ({ kind: "recovery", context, completion }));
    const existingLaunch = this.#agentLaunches.get(agentId);
    if (existingLaunch) {
      if (!recovery) return existingLaunch;
      const extendedLaunch = Promise.all([existingLaunch, enqueueRecovery(recovery)])
        .then(([runtime]) => runtime)
        .finally(() => {
          if (this.#agentLaunches.get(agentId) === extendedLaunch)
            this.#agentLaunches.delete(agentId);
        });
      this.#agentLaunches.set(agentId, extendedLaunch);
      return extendedLaunch;
    }
    const activeRuntime = this.#agentProcessManager.runtime(agentId);
    if (activeRuntime) {
      if (!recovery)
        return Promise.reject(new Error(`Agent runtime is already active: ${agentId}`));
      if (!recovery.wakeMessage) return Promise.resolve(activeRuntime);
      const recoveryCompletion = enqueueRecovery({ wakeMessage: recovery.wakeMessage });
      this.#ensureAgentInputDrain(agentId);
      return recoveryCompletion.then(() => activeRuntime);
    }

    this.#messageAttention.clearAgent(agentId);

    const recoveryCompletion = recovery ? enqueueRecovery(recovery) : undefined;
    // Register the launch before its first await so concurrent starts cannot mint twice.
    // Launch failure is surfaced by `launch`; the item completion is also rejected when cleared.
    void recoveryCompletion?.catch(() => {});
    const launch = this.#launchAgent(agentId, config, request)
      .then(
        async (runtime) => {
          this.#ensureAgentInputDrain(agentId);
          if (recoveryCompletion) await recoveryCompletion;
          return runtime;
        },
        (error: unknown) => {
          this.#closeAgentInputQueue(agentId, error);
          throw error;
        },
      )
      .finally(() => {
        if (this.#agentLaunches.get(agentId) === launch) this.#agentLaunches.delete(agentId);
      });
    this.#agentLaunches.set(agentId, launch);
    return launch;
  }

  #enqueueAgentInput(
    agentId: string,
    create: (completion: AgentInputCompletion) => AgentInput,
  ): Promise<void> {
    const queue = this.#agentInputQueues.get(agentId) ?? { items: [], closed: false };
    if (queue.closed) return Promise.reject(new Error(`Agent runtime is stopping: ${agentId}`));
    const completion = new Promise<void>((resolve, reject) => {
      queue.items.push(create({ resolve, reject }));
    });
    this.#agentInputQueues.set(agentId, queue);
    return completion;
  }

  #ensureAgentInputDrain(agentId: string): void {
    const queue = this.#agentInputQueues.get(agentId);
    if (!queue || queue.closed || queue.drain || !this.#agentProcessManager.session(agentId))
      return;
    queue.drain = this.#drainAgentInputs(agentId, queue).finally(() => {
      queue.drain = undefined;
      if (queue.closed || !queue.items.length) {
        if (this.#agentInputQueues.get(agentId) === queue) this.#agentInputQueues.delete(agentId);
        return;
      }
      this.#ensureAgentInputDrain(agentId);
    });
  }

  async #drainAgentInputs(agentId: string, queue: AgentInputQueue): Promise<void> {
    while (!queue.closed) {
      const item = queue.items.shift();
      if (!item) return;
      try {
        if (item.kind === "delivery") {
          await this.#messageAttention.receive(item.message);
          logger.info("Agent delivery indexed", {
            event: "agent.message.delivery_indexed",
            agent_id: agentId,
            delivery_id: item.message.deliveryId,
            message_id: item.message.messageId,
            target: item.message.target,
            sequence: item.message.sequence,
          });
        } else await this.#recoverAttention(agentId, item.context);
      } catch (error) {
        if (item.kind === "recovery" && this.#agentLaunches.has(agentId)) {
          item.completion.reject(await this.#abandonLaunch(agentId, error));
          return;
        }
        if (item.kind === "delivery") {
          item.completion.reject(error);
          continue;
        }
      }
      item.completion.resolve();
    }
  }

  async #recoverAttention(agentId: string, context: AgentRecoveryContext): Promise<void> {
    const messages = [
      ...(context.wakeMessage ? [context.wakeMessage] : []),
      ...(context.resumeMessages ?? []),
    ];
    try {
      if (messages.length || Object.keys(context.unreadSummary ?? {}).length)
        await this.#messageAttention.recover(agentId, messages, context.unreadSummary ?? {});
    } catch (error) {
      logger.warn("Agent recovery notice was not accepted; canonical unread state remains", {
        event: "agent.recovery_notice.rejected",
        agent_id: agentId,
        error_code: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  /** Tears down a launch whose recovery notice was rejected; returns the error to surface. */
  async #abandonLaunch(agentId: string, error: unknown): Promise<unknown> {
    this.#stoppingAgents.add(agentId);
    this.#closeAgentInputQueue(agentId, error);
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    if (activityLaunch) activityLaunch.stopping = true;
    this.#revokeLocalLaunch(agentId);
    try {
      await this.#releaseAgentRuntime(agentId);
      if (!this.#agentStops.has(agentId)) this.#stoppingAgents.delete(agentId);
      return error;
    } catch (cleanupError) {
      return cleanupError;
    }
  }

  #closeAgentInputQueue(agentId: string, error: unknown): void {
    const queue = this.#agentInputQueues.get(agentId);
    if (!queue) return;
    queue.closed = true;
    for (const item of queue.items.splice(0)) {
      item.completion.reject(error);
    }
    if (!queue.drain) this.#agentInputQueues.delete(agentId);
  }

  async #requestLaunchConfig(
    agentId: string,
    requestId: string,
    launch: ActivityLaunch,
    control: LaunchRequest["control"],
  ) {
    const { workspaceId } = this.#connection;
    if (this.#transport.requestAgentLaunchConfig)
      return this.#transport.requestAgentLaunchConfig({
        agentId,
        workspaceId,
        ...(control
          ? { controlEpoch: control.controlEpoch, requestId, launchId: launch.launchId }
          : {}),
      });
    if (this.#transport.requestAgentApiKey)
      return { agentApiKey: await this.#transport.requestAgentApiKey({ agentId, workspaceId }) };
    throw new Error("Agent API key endpoint is not configured");
  }

  async #launchAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    request: LaunchRequest,
  ): Promise<AgentRuntime> {
    const { control } = request;
    const previous = this.#sessionReferences.get(agentId);
    const continuing =
      previous?.provider === config.provider &&
      (!request.requestId || request.requestId === previous.requestId);
    const requestId = request.requestId ?? (continuing ? previous.requestId : crypto.randomUUID());
    const reference = {
      requestId,
      provider: config.provider,
      sessionId: request.sessionId ?? (continuing ? previous.sessionId : undefined),
      sessionMode: request.sessionMode ?? (continuing ? previous.sessionMode : undefined),
      launchId: request.previousLaunchId ?? (continuing ? previous.launchId : undefined),
    };
    const previousLaunchId = reference.launchId;
    this.#sessionReferences.set(agentId, reference);
    const launch: ActivityLaunch = {
      launchId: control?.launchId ?? crypto.randomUUID(),
      clientSeq: 0,
      stopping: false,
    };
    this.#currentActivityLaunches.set(agentId, launch);
    const current = () => this.#currentActivityLaunches.get(agentId) === launch && !launch.stopping;
    let agentApiKey: string | undefined;
    let stage: "credential" | "runtime" = "credential";
    try {
      const launchConfig = await this.#requestLaunchConfig(agentId, requestId, launch, control);
      agentApiKey = launchConfig.agentApiKey;
      this.#pendingAgentApiKeyRevokes.add(agentApiKey);
      this.#assertRunning();
      this.#assertAgentNotStopping(agentId);
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
          envVars: launchConfig.envVars,
        },
        agentWorkspaceDirectory(
          this.#connection.workspaceRoot,
          this.#connection.workspaceId,
          agentId,
        ),
        reference.sessionId,
        {
          COFORGE_DAEMON_SOCKET: "",
          COFORGE_AGENT_CONTEXT: localContext,
          COFORGE_AGENT_PROXY_URL: this.#agentProxy?.url ?? "",
        },
        launch.launchId,
        this.#transport.reportAgentSession
          ? async (reportedSessionId, replacedSessionId) => {
              if (!current() || this.#stopping)
                throw new Error("Agent session launch was superseded");
              const replaced = replacedSessionId ?? request.replacedSessionId;
              await this.#transport.reportAgentSession!({
                protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
                requestId: crypto.randomUUID(),
                workspaceId: this.#connection.workspaceId,
                computerId: this.#connection.computerId,
                agentId,
                provider: config.provider,
                sessionId: reportedSessionId,
                ...(replaced ? { replacedSessionId: replaced } : {}),
                startRequestId: requestId,
                daemonInstanceId: this.#runtimeInstanceId,
                launchId: launch.launchId,
                ...(control?.controlEpoch ? { controlEpoch: control.controlEpoch } : {}),
                ...(previousLaunchId ? { previousLaunchId } : {}),
              });
              if (!current()) return;
              reference.sessionId = reportedSessionId;
              reference.sessionMode = "resume";
              reference.launchId = launch.launchId;
              if (replaced)
                this.#emitAgentActivity(
                  agentId,
                  launch,
                  this.#activity(
                    agentId,
                    AGENT_ACTIVITY_DETAIL_KIND.OTHER,
                    "info",
                    "Original session history was not found. A new session was started; previous context was not restored.",
                  ),
                );
            }
          : undefined,
        reference.sessionMode,
      );
      if (this.#stoppingAgents.has(agentId)) {
        await this.#agentProcessManager.stop(agentId);
        throw new Error(`Agent runtime is stopping: ${agentId}`);
      }
      const trajectory = new ActivityTrajectory((event) =>
        this.#observeRuntimeEvent(agentId, launch, config, runtime, Boolean(control), event),
      );
      const unsubscribe = runtime.session.subscribe((event) => trajectory.accept(event));
      runtime.session.onExit(() => {
        trajectory.dispose();
        if (this.#currentActivityLaunches.get(agentId) !== launch) return;
        this.#messageAttention.clearAgent(agentId);
        this.#revokeLocalLaunch(agentId, localContext, proxyToken);
        void this.#revokeAgentApiKey(agentApiKey).catch(() => {
          // Local access is already revoked. Remote failure remains visible
          // through the transport contract and is never treated as success.
        });
        unsubscribe();
        if (launch.stopping) return;
        if (control)
          void runtime.session
            .readSessionIdentity?.()
            .then((identity) => this.#agentControl.stopped(agentId, launch.launchId, identity))
            .then(() => this.#agentSessions.replay(agentId))
            .catch(() => {});
        this.#emitAgentActivity(agentId, launch, this.#stoppedActivity(agentId));
        if (this.#currentActivityLaunches.get(agentId) === launch)
          this.#currentActivityLaunches.delete(agentId);
      });
      this.#sendAgentStatus(agentId, "active");
      this.#emitAgentActivity(agentId, launch, {
        ...this.#activity(
          agentId,
          AGENT_ACTIVITY_DETAIL_KIND.STARTING,
          "info",
          "Agent runtime is starting.",
        ),
        requestId,
      });
      void this.drainAppInboxNotices(agentId).catch(() => {});
      return runtime;
    } catch (error) {
      this.#revokeLocalLaunch(agentId);
      if (agentApiKey) {
        try {
          await this.#revokeAgentApiKey(agentApiKey);
        } catch {
          // Keep the plaintext handle in pendingAgentApiKeyRevokes for stop/retry.
        }
      }
      if (!this.#stopping && !this.#stoppingAgents.has(agentId)) {
        this.#sendAgentStatus(agentId, "inactive");
        this.#emitAgentActivity(
          agentId,
          launch,
          this.#runtimeErrorActivity(agentId, this.#launchFailureMessage(agentId, stage, error)),
        );
      }
      if (this.#currentActivityLaunches.get(agentId) === launch)
        this.#currentActivityLaunches.delete(agentId);
      throw error;
    }
  }

  /** Translates one coalesced provider event into cloud Activity, Session and usage updates. */
  #observeRuntimeEvent(
    agentId: string,
    launch: ActivityLaunch,
    config: AgentRuntimeConfig,
    runtime: AgentRuntime,
    controlled: boolean,
    event: AgentRuntimeEvent,
  ): void {
    if (event.type === "session") {
      if (controlled)
        void this.#agentSessions.update(agentId, launch.launchId, event.identity).catch(() => {});
      return;
    }
    if (event.type === AGENT_RUNTIME_EVENT_TYPE.USAGE) {
      if (event.snapshot.provider === config.provider) this.#rememberUsage(event.snapshot);
      return;
    }
    if (event.type === "activity") {
      const { activity } = event;
      const carriesEntries =
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING &&
        activity.entries?.some((entry) => entry.kind !== "tool_start");
      this.#emitAgentActivity(agentId, launch, {
        ...this.#activity(
          agentId,
          activity.detailKind,
          activity.level,
          carriesEntries
            ? ""
            : safeRuntimeActivityMessage(activity.detailKind, activity.level, activity.detail),
          { entries: activity.entries },
        ),
        ...(activity.runtimeError
          ? { runtimeError: activity.runtimeError }
          : activity.level === "error"
            ? { runtimeError: runtimeFailureDiagnostic(activity.detail) }
            : {}),
      });
      if (activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.IDLE)
        void this.drainAppInboxNotices(agentId).catch(() => {});
      return;
    }
    if (event.type !== "completed") return;
    if (controlled)
      void runtime.session
        .readSessionIdentity?.()
        .then(async (identity) => {
          if (identity) await this.#agentSessions.update(agentId, launch.launchId, identity);
        })
        .catch(() => {});
    this.#emitAgentActivity(
      agentId,
      launch,
      event.status === "failed"
        ? {
            ...this.#runtimeErrorActivity(agentId, "Agent runtime failed."),
            runtimeError: runtimeFailureDiagnostic("turn failure"),
          }
        : this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.IDLE, "info", ""),
    );
    void this.drainAppInboxNotices(agentId).catch(() => {});
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

  #currentObservedUsage(provider: RuntimeProvider): UsageSnapshot | undefined {
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

  #assertOwnIntent(intent: {
    protocolMajor: number;
    workspaceId: string;
    computerId?: string;
  }): void {
    if (intent.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (intent.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent intent targets another Workspace");
    if (intent.computerId !== this.#connection.computerId)
      throw new Error("agent intent targets another Computer");
  }

  async handleAgentStart(intent: AgentStartIntent): Promise<AgentRuntime> {
    this.#assertOwnIntent({
      ...intent,
      computerId: intent.computerId || this.#connection.computerId,
    });
    if (intent.controlEpoch) {
      await this.#agentControl.start(intent);
      await this.#agentSessions.replay(intent.agentId);
      const runtime = this.#agentProcessManager.runtime(intent.agentId);
      if (!runtime) throw new Error("Agent managed launch did not complete");
      return runtime;
    }
    if (this.#agentControl.managed(intent.agentId))
      throw new Error("Agent requires a fenced Start");
    const stopping = this.#agentStops.get(intent.agentId);
    if (stopping) await stopping;
    return this.#startAgent(intent.agentId, runtimeConfigOf(intent), recoveryOf(intent), {
      sessionId: intent.sessionId,
      requestId: intent.requestId,
      previousLaunchId: intent.previousLaunchId,
      sessionMode: intent.sessionMode,
    });
  }

  async handleAgentWorkspaceReset(request: AgentWorkspaceResetRequest): Promise<void> {
    if (
      !this.#started ||
      this.#stopping ||
      request.workspaceId !== this.#connection.workspaceId ||
      request.computerId !== this.#connection.computerId
    )
      throw new Error("Agent control scope unavailable");
    await this.#agentControl.resetWorkspace(request);
  }

  async handleAgentStop(intent: AgentStopIntent): Promise<void> {
    this.#assertOwnIntent(intent);
    if (intent.provider !== undefined && intent.controlEpoch !== undefined) {
      await this.#agentControl.stop({
        protocolMajor: intent.protocolMajor,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        computerId: intent.computerId,
        agentId: intent.agentId,
        provider: intent.provider,
        epoch: intent.controlEpoch,
      });
      return;
    }
    if (this.#agentControl.managed(intent.agentId)) throw new Error("Agent requires a fenced Stop");
    await this.stopAgent(intent.agentId);
  }

  async handleAgentMessage(message: AgentMessageDelivery): Promise<void> {
    this.#assertRunning();
    if (this.#stoppingAgents.has(message.agentId))
      throw new Error(`Agent runtime is stopping: ${message.agentId}`);
    if (message.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (message.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent message targets another Workspace");
    const delivery = this.#enqueueAgentInput(message.agentId, (completion) => ({
      kind: "delivery",
      message,
      completion,
    }));
    if (this.#agentProcessManager.session(message.agentId)) {
      this.#ensureAgentInputDrain(message.agentId);
      return delivery;
    }
    if (this.#agentLaunches.has(message.agentId)) return delivery;
    const wakeable = this.#agentProcessManager.restartConfig(message.agentId);
    if (!wakeable) {
      this.#closeAgentInputQueue(message.agentId, new Error("Agent is inactive"));
      return delivery;
    }
    const launch = this.#startAgent(message.agentId, wakeable.config, undefined, {
      sessionId: wakeable.sessionId,
    });
    await Promise.all([launch, delivery]);
  }

  stopAgent(agentId: string): Promise<void> {
    const existingStop = this.#agentStops.get(agentId);
    if (existingStop) return existingStop;
    // Close this Agent's launch gate and local capabilities before the first await.
    this.#stoppingAgents.add(agentId);
    this.#sessionReferences.delete(agentId);
    this.#closeAgentInputQueue(agentId, new Error(`Agent runtime is stopping: ${agentId}`));
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    if (activityLaunch) activityLaunch.stopping = true;
    this.#revokeLocalLaunch(agentId);
    const stopping = this.#stopAgent(agentId)
      .catch((error) => {
        if (activityLaunch)
          this.#emitAgentActivity(
            agentId,
            activityLaunch,
            this.#runtimeErrorActivity(agentId, this.#stopFailureMessage(agentId, error)),
          );
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
    const inputDrain = this.#agentInputQueues.get(agentId)?.drain;
    if (inputDrain) await Promise.allSettled([inputDrain]);
    await this.#releaseAgentRuntime(agentId, true);
  }

  async #releaseAgentRuntime(agentId: string, publishStopped = false): Promise<void> {
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    const results = await Promise.allSettled([
      this.#revokeAgentApiKey(this.#agentApiKeys.get(agentId)),
      this.#agentProcessManager.stop(agentId),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
    this.#messageAttention.clearAgent(agentId);
    this.#sendAgentStatus(agentId, "inactive");
    if (publishStopped && activityLaunch)
      this.#emitAgentActivity(agentId, activityLaunch, this.#stoppedActivity(agentId));
    this.#currentActivityLaunches.delete(agentId);
  }

  #readyRunningAgentIds(): string[] {
    return this.#agentProcessManager
      .runningAgentIds()
      .filter(
        (agentId) =>
          !this.#agentLaunches.has(agentId) &&
          !this.#stoppingAgents.has(agentId) &&
          !this.#agentProcessManager.isStopping(agentId),
      );
  }

  /** Revokes the Agent's local context and proxy token; defaults to whatever is currently issued. */
  #revokeLocalLaunch(
    agentId: string,
    context = this.#agentContexts.get(agentId),
    proxyToken = this.#agentProxyTokens.get(agentId),
  ): void {
    if (context && this.#agentContexts.get(agentId) === context)
      this.#agentContexts.delete(agentId);
    if (proxyToken && this.#agentProxyTokens.get(agentId) === proxyToken)
      this.#agentProxyTokens.delete(agentId);
    if (proxyToken) this.#agentProxy?.revoke(proxyToken);
  }

  #activity(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra: Partial<ActivityDraft> = {},
  ): ActivityDraft {
    return {
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      agentId,
      detailKind,
      level,
      detail,
      ...extra,
    };
  }

  #runtimeErrorActivity(agentId: string, detail: string): ActivityDraft {
    return this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR, "error", detail);
  }

  #stoppedActivity(agentId: string): ActivityDraft {
    return this.#activity(
      agentId,
      AGENT_ACTIVITY_DETAIL_KIND.STOPPED,
      "info",
      "Agent runtime stopped",
    );
  }

  /** Emits against the Agent's current launch, if one exists. */
  #emitCurrentActivity(agentId: string, activity: ActivityDraft): void {
    const launch = this.#currentActivityLaunches.get(agentId);
    if (launch) this.#emitAgentActivity(agentId, launch, activity);
  }

  #emitAgentActivity(agentId: string, launch: ActivityLaunch, activity: ActivityDraft): void {
    if (!this.#activityEnabled || this.#currentActivityLaunches.get(agentId) !== launch) return;
    if (
      launch.stopping &&
      activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.STOPPED &&
      activity.level !== "error" &&
      !activity.entries?.some((entry) => entry.kind !== "tool_start")
    )
      return;
    this.#transport.sendAgentActivity?.({
      ...activity,
      launchId: launch.launchId,
      clientSeq: ++launch.clientSeq,
      observedAtMs: Date.now(),
    });
  }

  #sendAgentStatus(agentId: string, status: "active" | "inactive"): void {
    const clientSeq = (this.#agentStatusSequences.get(agentId) ?? 0) + 1;
    this.#agentStatusSequences.set(agentId, clientSeq);
    this.#transport.sendAgentStatus?.({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
      agentId,
      status,
      daemonInstanceId: this.#runtimeInstanceId,
      clientSeq,
      observedAtMs: this.#startedAt,
    });
  }

  #cleanupUnconfirmed(agentId: string, error: unknown): boolean {
    return (
      error instanceof AgentProcessCleanupError || this.#agentProcessManager.isStopping(agentId)
    );
  }

  #launchFailureMessage(agentId: string, stage: "credential" | "runtime", error: unknown): string {
    if (this.#cleanupUnconfirmed(agentId, error)) return CLEANUP_UNCONFIRMED;
    return stage === "credential"
      ? "Agent authorization could not be prepared."
      : "Agent runtime could not be started.";
  }

  #stopFailureMessage(agentId: string, error: unknown): string {
    if (this.#cleanupUnconfirmed(agentId, error)) return CLEANUP_UNCONFIRMED;
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
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!this.#transport.agentMessage) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    logger.info("Agent message operation received", {
      event: "agent.message.operation",
      agent_id: agentId,
      operation: request.operation,
      target: request.target ?? "*",
    });
    const target = request.target
      ? await this.#canonicalAgentMessageTarget(agentId, request.target, agentApiKey)
      : undefined;
    const { operation } = request;
    if (operation === "check")
      return this.#checkAgentMessages(agentId, request, target, agentApiKey);
    if (operation === "send" && target)
      return this.#sendAgentMessage(agentId, request, target, agentApiKey);
    return this.#forwardAgentMessage(agentId, request, operation, target, agentApiKey);
  }

  /** Reads every pending thread for the Agent and marks what the model has now seen. */
  async #checkAgentMessages(
    agentId: string,
    request: LocalAgentMessageRequest,
    target: string | undefined,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const startedAt = performance.now();
    const attention = this.#messageAttention
      .check(agentId)
      .filter((item) => !target || item.target === target);
    logger.info("Agent message check queried attention", {
      event: "agent.message.check_attention",
      agent_id: agentId,
      target: target ?? "*",
      attention_count: attention.length,
    });
    const messages: AgentMessageRecord[] = [];
    for (const item of attention) {
      let fromSequence: number | undefined;
      let visibleSequence = 0;
      while (fromSequence === undefined || fromSequence <= item.latestSequence) {
        const result = await this.#transport.agentMessage!(
          {
            protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
            requestId: request.requestId,
            agentId,
            workspaceId: this.#connection.workspaceId,
            operation: "read",
            target: item.target,
            limit: request.limit,
            fromSequence,
            throughSequence: item.latestSequence,
          },
          agentApiKey,
        );
        if (!result.accepted) break;
        const page = result.messages.filter(
          ({ sequence, target }) =>
            target === item.target &&
            (fromSequence === undefined || sequence >= fromSequence) &&
            sequence <= item.latestSequence,
        );
        if (!page.length) break;
        messages.push(
          ...page.filter(
            ({ sender }) =>
              isChannelMessageTarget(item.target) || sender === item.target.split(":")[0],
          ),
        );
        visibleSequence = Math.max(visibleSequence, ...page.map(({ sequence }) => sequence));
        fromSequence = visibleSequence + 1;
        if (!result.hasNewer) break;
      }
      if (visibleSequence > 0)
        this.#messageAttention.recordModelSeen(agentId, item.target, visibleSequence);
    }
    logger.info("Agent checked pending messages", {
      event: "agent.message.checked",
      ...this.#agentLogScope(agentId, request.requestId),
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

  /** Sends a body or a held draft, honouring the server's freshness hold decision. */
  async #sendAgentMessage(
    agentId: string,
    request: LocalAgentMessageRequest,
    target: string,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const startedAt = performance.now();
    const inbox = this.#agentInbox(agentId);
    const draft = request.sendDraft ? await inbox.draft(target) : undefined;
    if (request.sendDraft && !draft) throw new Error(`No held draft for target: ${target}`);
    const body = draft?.body ?? request.body;
    if (body === undefined) throw new Error("Agent message body is required");
    if (!request.sendDraft) await inbox.save(target, body);
    if (request.sendDraft && !draft?.holdToken)
      throw new Error(`Held draft token is unavailable for target: ${target}`);
    const result = await this.#transport.agentMessage!(
      {
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        agentId,
        workspaceId: this.#connection.workspaceId,
        operation: "send",
        target,
        body,
        holdToken: draft?.holdToken,
        continueAnyway: request.continueAnyway,
        seenUpToSequence: this.#messageAttention.modelSeenSequence(agentId, target) || undefined,
        freshnessContextMode: request.freshnessContextMode,
      },
      agentApiKey,
    );
    const held = result.sideEffectDecision === "hold";
    if (held && result.holdToken) await inbox.replace(target, body, result.holdToken);
    else if (result.accepted) await inbox.clear(target);
    const withheld = request.freshnessContextMode === "withheld";
    const targetMessages = result.messages.filter((message) => message.target === target);
    if (!withheld && targetMessages.length > 0)
      this.#messageAttention.recordModelSeen(
        agentId,
        target,
        Math.max(...targetMessages.map(({ sequence }) => sequence)),
      );
    if (held)
      this.#emitCurrentActivity(
        agentId,
        this.#activity(
          agentId,
          AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
          "info",
          "Reply held until the Agent reviews newer messages.",
        ),
      );
    logger.info("Agent sent a message", {
      event: "agent.message.sent",
      ...this.#agentLogScope(agentId, request.requestId),
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
      messages: withheld ? [] : result.messages,
      summaries: [],
      sideEffectDecision:
        result.sideEffectDecision === "anyway_accepted"
          ? "bypass"
          : result.sideEffectDecision === "anyway_denied"
            ? undefined
            : result.sideEffectDecision,
      anywayAllowed: result.anywayAllowed,
      freshnessContextMode: result.freshnessContextMode,
      withheldMessageCount: withheld
        ? (result.withheldMessageCount ?? result.attentionCount)
        : undefined,
    };
  }

  /** Forwards read/search/mute/unmute/unfollow unchanged; an unpaged read settles attention. */
  async #forwardAgentMessage(
    agentId: string,
    request: LocalAgentMessageRequest,
    operation: Exclude<LocalAgentMessageRequest["operation"], "check">,
    target: string | undefined,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const settlesAttention =
      operation === "read" && target && !request.before && !request.after && !request.around;
    const attentionUpperBound = settlesAttention
      ? this.#messageAttention.check(agentId).find((item) => item.target === target)?.latestSequence
      : undefined;
    const result = await this.#transport.agentMessage!(
      {
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        agentId,
        workspaceId: this.#connection.workspaceId,
        operation,
        target: target ?? "",
        body: request.body,
        before: request.before,
        after: request.after,
        around: request.around,
        limit: request.limit,
        query: request.query,
        sender: request.sender,
        sort: request.sort,
        offset: request.offset,
        messageId: request.messageId,
        emoji: request.emoji,
      },
      agentApiKey,
    );
    if (settlesAttention && result.accepted) {
      const visibleSequence = Math.max(
        ...result.messages
          .filter((message) => message.target === target)
          .map(({ sequence }) => sequence),
        0,
      );
      if (visibleSequence > 0)
        this.#messageAttention.recordModelSeen(agentId, target, visibleSequence);
      else if (result.messages.length === 0 && attentionUpperBound !== undefined)
        this.#messageAttention.clearThrough(agentId, target, attentionUpperBound);
    }
    return {
      requestId: request.requestId,
      accepted: result.accepted,
      attentionCount: result.attentionCount,
      messageId: result.messageId ?? "",
      messages: result.messages,
      summaries: [],
      hasOlder: result.hasOlder,
      hasNewer: result.hasNewer,
      olderCursor: result.olderCursor,
      newerCursor: result.newerCursor,
    };
  }

  #agentLogScope(agentId: string, requestId: string) {
    return {
      request_id: requestId,
      workspace_id: this.#connection.workspaceId,
      computer_id: this.#connection.computerId,
      agent_id: agentId,
    };
  }

  async workspaceInfo(
    context: string,
    request: WorkspaceInfoRequest,
    agentApiKey?: string,
  ): Promise<WorkspaceInfoResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.workspaceInfo) throw new Error("daemon connection is not connected");
    return this.#transport.workspaceInfo(request, agentApiKey);
  }

  async agentTask(
    context: string,
    command: TaskCommand,
    agentApiKey?: string,
  ): Promise<TaskResult> {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!this.#transport.agentTask) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    const freshnessAction = command.operation === "claim" || command.operation === "update";
    if (freshnessAction && command.target) {
      const held = await this.#heldTaskResult(agentId, command, command.target, agentApiKey);
      if (held) return held;
    }
    return this.#transport.agentTask(
      {
        ...command,
        protocolMajor: TASK_PROTOCOL_MAJOR,
        workspaceId: this.#connection.workspaceId,
        agentId,
      },
      agentApiKey,
    );
  }

  /** Applies the attention preflight to a Task claim/update; returns the held result, if any. */
  async #heldTaskResult(
    agentId: string,
    command: TaskCommand,
    target: string,
    agentApiKey: string,
  ): Promise<TaskResult | undefined> {
    const attention = this.#messageAttention.check(agentId).find((item) => item.target === target);
    if (command.freshnessContextMode === "withheld")
      return attention
        ? {
            tasks: [],
            state: "held",
            freshnessContextMode: "withheld",
            withheldMessageCount: attention.pendingCount,
          }
        : undefined;
    const modelSeen = this.#messageAttention.modelSeenSequence(agentId, target);
    if (!attention && modelSeen !== 0) return undefined;
    const context = await this.#transport.agentMessage?.(
      {
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        agentId,
        workspaceId: this.#connection.workspaceId,
        operation: "read",
        target,
        limit: 3,
        ...(attention
          ? {
              fromSequence: attention.firstPendingSequence,
              throughSequence: attention.latestSequence,
            }
          : {}),
      },
      agentApiKey,
    );
    const heldMessages = (context?.accepted ? context.messages : [])
      .filter((message) => message.target === target && message.sequence > modelSeen)
      .slice(-3);
    if (heldMessages.length > 0) {
      this.#messageAttention.recordModelSeen(
        agentId,
        target,
        Math.max(...heldMessages.map(({ sequence }) => sequence)),
      );
      return {
        tasks: [],
        state: "held",
        freshnessContextMode: "inline",
        heldMessages,
        newMessageCount: attention?.pendingCount ?? heldMessages.length,
      };
    }
    if (!attention) return undefined;
    return {
      tasks: [],
      state: "held",
      freshnessContextMode: "inline",
      heldMessages: [],
      newMessageCount: attention.pendingCount,
    };
  }

  async #canonicalAgentMessageTarget(
    agentId: string,
    target: string,
    agentApiKey: string,
  ): Promise<string> {
    if (FULL_THREAD_TARGET.test(target) || !target.includes(":")) return target;
    const match = SHORT_THREAD_TARGET.exec(target);
    if (!match) return target;
    const parent = match[1]!;
    const result = await this.#transport.agentMessage!(
      {
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        agentId,
        workspaceId: this.#connection.workspaceId,
        operation: "read",
        target: parent,
        around: match[2],
        limit: 1,
      },
      agentApiKey,
    );
    const root = result.messages[0];
    if (
      !result.accepted ||
      result.messages.length !== 1 ||
      root?.target !== parent ||
      !FULL_THREAD_TARGET.test(`${parent}:${root.id}`)
    )
      throw new Error("thread target could not be resolved to one parent message");
    return `${parent}:${root.id}`;
  }

  async mintAppItem(agentId: string, input: MintAppItem) {
    const item = await (await this.#appInbox(agentId)).upsert(input);
    await this.#notifyAppItem(agentId, item.itemId);
    return item;
  }

  async reminder(context: string, request: LocalReminderRequest, agentApiKey: string) {
    const agentId = this.#authorizedAgent(context, agentApiKey);
    if (request.operation === "ack" || request.operation === "dismiss") {
      const accepted = await this.#reminders.acknowledge(
        agentId,
        request.reminderId!,
        request.revision!,
      );
      if (!accepted)
        return { accepted: false, reason: "reminder receipt not found for exact revision" };
      await (
        await this.#appInbox(agentId)
      ).remove(`reminder:${request.reminderId}:${request.revision}`);
      return { accepted: true, reminderId: request.reminderId, revision: request.revision };
    }
    if (!this.#transport.agentReminder) throw new Error("Agent reminder transport is unavailable");
    const { context: _context, revision: _revision, ...fields } = request;
    return this.#transport.agentReminder(
      {
        ...fields,
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        workspaceId: this.#connection.workspaceId,
        computerId: this.#connection.computerId,
        agentId,
      } as AgentReminderOperationRequest,
      agentApiKey,
    );
  }

  async #acceptReminderDue(job: ReminderJob): Promise<boolean> {
    const item = await (
      await this.#appInbox(job.ownerAgentId)
    ).upsert({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: job.reminderId, revision: String(job.version) },
      title: reminderAppInboxPreview(job.title),
      summary: "Reminder due",
    });
    return this.#notifyAppItem(job.ownerAgentId, item.itemId);
  }

  async #requestReminderSnapshot(agentId: string): Promise<void> {
    if (!this.#transport.requestSnapshot) return;
    const sync: ReminderSync = await this.#transport.requestSnapshot({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
      agentId,
    });
    await this.#reminders.apply(sync);
  }

  async inbox(context: string, request: LocalInboxRequest): Promise<InboxResponse> {
    this.#assertRunning();
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

  async #notifyAppItem(agentId: string, itemId: string): Promise<boolean> {
    const notified = this.#notifiedAppItems.get(agentId) ?? new Map<string, Promise<boolean>>();
    this.#notifiedAppItems.set(agentId, notified);
    const existing = notified.get(itemId);
    if (existing) return existing;
    const pending = Promise.resolve().then(async () => {
      let session = this.#agentProcessManager.session(agentId);
      if (!session) {
        const wakeable = this.#agentProcessManager.restartConfig(agentId);
        if (!wakeable) return false;
        session = (
          await this.#startAgent(agentId, wakeable.config, undefined, {
            sessionId: wakeable.sessionId,
          })
        ).session;
      }
      if (!session.notify) return false;
      await session.notify("New app item available. Run coforge inbox check.");
      return true;
    });
    notified.set(itemId, pending);
    try {
      const accepted = await pending;
      if (!accepted && notified.get(itemId) === pending) notified.delete(itemId);
      return accepted;
    } catch (error) {
      if (notified.get(itemId) === pending) notified.delete(itemId);
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
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachment) throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachment(attachmentId, agentApiKey);
  }

  #contextFor(agentId: string): string {
    const context = crypto.randomUUID();
    this.#agentContexts.set(agentId, context);
    return context;
  }

  issueAgentContext(agentId: string, context: string = crypto.randomUUID()): string {
    this.#assertRunning();
    this.#agentContexts.set(agentId, context);
    void this.#requestReminderSnapshot(agentId).catch(() => {});
    return context;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    // Close every local capability synchronously before any shutdown await.
    this.#stopping = true;
    this.#started = false;
    this.#activityEnabled = false;
    for (const agentId of this.#agentInputQueues.keys())
      this.#closeAgentInputQueue(agentId, new Error("daemon runtime is stopping"));
    this.#unsubscribeAll();
    this.#reminders.stop();
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
    const sessions = activeAgentIds.map((id) => ({
      id,
      session: this.#agentProcessManager.session(id),
      launchId: this.#currentActivityLaunches.get(id)?.launchId,
    }));
    let shutdownError: unknown;
    try {
      await this.#agentProcessManager.shutdown();
      for (const { id, session, launchId } of sessions) {
        if (launchId)
          await this.#agentControl.stopped(id, launchId, await session?.readSessionIdentity?.());
        await this.#agentSessions.replay(id);
      }
    } catch (error) {
      shutdownError = error;
    }
    for (const agentId of activeAgentIds) this.#sendAgentStatus(agentId, "inactive");
    this.#currentActivityLaunches.clear();
    this.#sessionReferences.clear();
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
  if (level === "error") return message.slice(0, 512);
  if (level === "warning") return scrubActivityText(message);
  if (activity === AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND)
    return [...scrubActivityText(message)].slice(0, 100).join("");
  if (
    activity === AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING
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
    errorReason: "runtime_failure",
    fingerprint: (hash >>> 0).toString(16).padStart(8, "0"),
  };
}

function validUsageWindow(window: UsageSnapshot["primary"], now: number): UsageSnapshot["primary"] {
  return window && Date.parse(window.resetsAt) > now ? window : undefined;
}

export function createDaemonRuntime(input: {
  createProvider: CodeAgentProviderFactory;
  credentials: DaemonCredentialStore;
  transportFactory: DaemonConnectionClientFactory;
}): (connection: DaemonConfig) => DaemonRuntime {
  return (connection) =>
    new DaemonRuntime(connection, input.createProvider, input.credentials, input.transportFactory);
}

export type { CodeAgentProviderFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
