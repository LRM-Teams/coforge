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
import { parseAssignedSkillPacks } from "../code-agent/assigned-skills";
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
  type AgentActivity,
  type AgentSessionInvalidate,
  type AgentSessionInvalidateReason,
  type AgentMessageRecord,
  type AgentMessageResponse,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  type AgentStartIntent,
  type AgentStopIntent,
  type AgentActivityProbe,
  type AgentWorkspaceResetRequest,
  type AgentMessageDelivery,
  type InboxResponse,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  type RuntimeProvider,
  type RuntimeMetadata,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type CodeAgentModelCatalog,
  type UsageScanResponse,
  REMINDER_CAPABILITY,
  type AgentReminderOperationRequest,
  type LocalReminderRequest,
  type ReminderJob,
  type ReminderSync,
  type TaskCommand,
  type TaskResult,
  type ChannelCommand,
  type WeeklyReportCommand,
  type WeeklyReportResponse,
  WEEKLY_REPORT_PROTOCOL_MAJOR,
  threadParentTarget,
  mentionsInContent,
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
import { AgentPreflightError } from "./agent-preflight-error";
import {
  discoverCodeAgentRuntimes,
  discoverCodeAgentCatalogs,
  loadCachedCodeAgentCatalogs,
} from "../code-agent/runtime-inventory";
import { getLogger } from "@logtape/logtape";
import { COFORGE_DAEMON_VERSION } from "../version";
import { ReminderScheduler, reminderAppInboxPreview } from "../agent-reminder/reminder-scheduler";
import { FileReminderReceiptStore } from "../persistence/reminder-receipt-store";
import { diagnosticErrorCode } from "../platform/diagnostic-error-code";
import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  GitHubCredentialRequest,
  GitHubCredentialResponse,
} from "@lrm/coforge-sdk/agent";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * The injectable half of Code Agent discovery. `runtimes` is the fast, always-awaited probe;
 * `cachedCatalogs` is a disk-only read (no spawning) used for the same report; `catalogs` is the
 * live, possibly-spawning discovery used only for the background refresh.
 */
export type CodeAgentDiscovery = {
  runtimes(): Promise<RuntimeMetadata[]>;
  cachedCatalogs(
    runtimes: RuntimeMetadata[],
  ): Promise<{ catalogs: CodeAgentModelCatalog[]; needsRefresh: boolean }>;
  catalogs(runtimes: RuntimeMetadata[]): Promise<CodeAgentModelCatalog[]>;
};

function defaultCodeAgentDiscovery(stateDirectory: string): CodeAgentDiscovery {
  return {
    runtimes: () => discoverCodeAgentRuntimes({ cacheDirectory: stateDirectory }),
    cachedCatalogs: (runtimes) =>
      loadCachedCodeAgentCatalogs(runtimes, { cacheDirectory: stateDirectory }),
    catalogs: (runtimes) => discoverCodeAgentCatalogs(runtimes, { cacheDirectory: stateDirectory }),
  };
}

/** A terminal upgrade operation carried forward from the Coordinator's durable record. */
export type RecoveredUpgradeResult = {
  requestId: string;
  status: "succeeded" | "failed";
  completedAtMs: number;
  version?: string;
  error?: string;
};
const FULL_THREAD_TARGET =
  /^((?:@[^:]+)|(?:#[a-z0-9][a-z0-9_-]{0,31})):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SHORT_THREAD_TARGET = /^((?:@[^:]+)|(?:#[a-z0-9][a-z0-9_-]{0,31})):([0-9a-f]{8})$/;
const NOT_RUNNING = "daemon runtime is not running";
const CLEANUP_UNCONFIRMED =
  "Agent process cleanup could not be confirmed. Replacement launch is blocked.";

/**
 * `AgentControl`'s fixed rejection messages (agent-runtime/agent-control.ts). They are stable,
 * low-cardinality identifiers, safe to log verbatim as `control_code` — unlike an arbitrary error
 * message, which `diagnosticErrorCode` deliberately never logs raw.
 */
const CONTROL_ERROR_CODES = new Set([
  "previous_control_not_completed",
  "previous_process_stop_unconfirmed",
  "stale_control_request",
  "control_request_mismatch",
  "control_record_missing",
  "control_epoch_required",
  "agent_already_running",
  "confirmed_stop_required",
]);

/** `{ control_code }` when `error` is one of AgentControl's fixed rejection messages, else `{}`. */
function controlCodeField(error: unknown): { control_code: string } | Record<string, never> {
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && CONTROL_ERROR_CODES.has(message) ? { control_code: message } : {};
}
/** Bounds how many events pages one `check` drains before reporting `hasMore: true` and yielding. */
const MAX_EVENT_DRAIN_ROUNDS = 50;

/**
 * The `--target-confirmed` guard's message: `target` is the top-level target the send is about to
 * hit, `threadTarget` is the most recently read thread rooted under it. Raft-aligned recovery: the
 * outgoing content is saved as the local draft for `target` before this is thrown (`draftSaved:
 * true`, carried through `AgentPreflightError.draftSaved`/`agent-proxy-failure.ts`'s `draft_saved`
 * field), so the saved-draft resend below is `--send-draft`, not retyped content.
 * `#sendAgentMessage` still cannot carry a `suggestedNextAction` through
 * `AgentPreflightError`/`agent-proxy-failure.ts` today, so the equivalent guidance is folded into
 * the message text itself instead.
 */
function targetConfirmationRequiredMessage(target: string, threadTarget: string): string {
  return [
    `Possible thread target mismatch: your latest read context under ${target} is ${threadTarget}, but this send targets ${target} top-level.`,
    "This guard is intentionally narrow: moving a thread conclusion to the parent channel can be correct, but it is uncommon enough to confirm once.",
    "",
    "If this reply belongs in the thread, send the message to the thread target instead:",
    `  coforge message send --target "${threadTarget}" <<'COFORGE_MESSAGE'`,
    "  message body",
    "  COFORGE_MESSAGE",
    "",
    "If the top-level channel message is intentional, send the saved draft unchanged:",
    `  coforge message send --send-draft --target "${target}"`,
    "",
    `No message was sent. Send to ${threadTarget} if this belongs in the thread, or confirm the saved top-level draft with \`coforge message send --send-draft --target "${target}"\`.`,
  ].join("\n");
}

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

// While an Agent stays busy (working/thinking) through a long silent turn, the
// daemon re-sends the last busy Activity frame every 60s with isHeartbeat set
// so the server's 90s display lease (WORKING_LEASE_MS) never lapses; the 30s
// margin matches AGENT_STATUS_LEASE_MS's margin over AGENT_STATUS_REFRESH_MS.
// Kept here, not in daemon-connection.ts: the macOS lifecycle fixture replaces
// that module with a stub that only exports the connection class.
export const ACTIVITY_HEARTBEAT_MS = 60_000;

/** Detail kinds the busy heartbeat keeps warm: the Agent is working or thinking. */
const BUSY_ACTIVITY_DETAIL_KINDS = new Set<string>([
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS,
  // Liveness-only fillers (ADR 0021): busy, but content-free.
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  // Visible, stored busy detail kinds (ADR 0021).
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT,
  AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY,
  AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
]);

/** Detail kinds that end a busy turn; the heartbeat stops as soon as one is observed. */
const TERMINAL_ACTIVITY_DETAIL_KINDS = new Set<string>([
  AGENT_ACTIVITY_DETAIL_KIND.IDLE,
  AGENT_ACTIVITY_DETAIL_KIND.STOPPED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
  AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
]);

/** Providers can emit runtime_progress once per coalesced provider event; cap it
 * here, centrally, so a chatty stream can never flood the transport or history. */
const RUNTIME_PROGRESS_RATE_LIMIT_MS = 10_000;

/** One Agent that is still mid-turn when the runner hold is polled. */
export type BusyAgentReport = { agentId: string; detailKind: string; busySinceMs: number };

type SessionMode = "create" | "resume";

/** Cloud-supplied identity for one launch; every field falls back to the previous reference. */
type LaunchRequest = {
  sessionId?: string;
  requestId?: string;
  previousLaunchId?: string;
  sessionMode?: SessionMode;
  control?: { controlEpoch?: number; launchId: string };
  replacedSessionId?: string;
  /** Set only alongside `replacedSessionId`, threaded from `AgentControl.start()`'s retry
   * launch through `Runtime.launch(...)`; narrates the retry's cold-start Activity with the
   * reason that was actually reported. Replaces the old `#pendingSessionInvalidateReason`
   * side-channel map: a reason can no longer outlive its launch or attach to an unrelated one,
   * and is never set without being consumed. */
  invalidateReason?: AgentSessionInvalidateReason;
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

/** Human runtime label for an invalidated-session Activity notice. */
function runtimeDisplayName(provider: AgentStartIntent["provider"]): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    case "kiro":
      return "Kiro";
    case "pi":
      return "Pi";
    case "coforge":
      return "CoForge";
    default:
      return provider;
  }
}

/** Raft-equivalent narration for a daemon-initiated cold start after a session invalidate. */
function sessionInvalidateActivityText(
  runtimeLabel: string,
  staleSessionId: string,
  reason: AgentSessionInvalidateReason,
): { detail: string; entryText: string } {
  const rejected = reason === "provider_replay_rejected";
  return {
    detail: `Stored ${runtimeLabel} session ${rejected ? "replay rejected" : "missing"}; cold-starting a new session…`,
    entryText: `Stored ${runtimeLabel} session ${staleSessionId} ${rejected ? "was rejected by the provider during replay" : "is unavailable locally"}. Falling back to a cold start; earlier runtime context may not be restored.`,
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
  /** agentApiKey -> agentId, for keys whose remote revoke has not confirmed yet. Revoke is
   * best-effort (docs/adr/0033): Stop's outcome depends only on the local process, so a key
   * stays here until it is retried on the next ready/reconnect pass or at shutdown. */
  readonly #pendingAgentApiKeyRevokes = new Map<string, string>();
  readonly #observedUsage = new Map<RuntimeProvider, UsageSnapshot>();
  readonly #agentProxy?: AgentProxy;
  readonly #activityHeartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #lastBusyActivity = new Map<
    string,
    { launch: ActivityLaunch; activity: ActivityDraft; at: number }
  >();
  /** Runner-hold reason while this runtime is refusing new turns; undefined when not held.
   * Deliberately in-memory only, so a restarted daemon is never born held (ADR 0020). */
  #runnerHold: string | undefined;
  readonly #lastRuntimeProgressAt = new Map<string, number>();
  readonly #codeAgentDiscovery: CodeAgentDiscovery;

  constructor(
    connection: DaemonConfig,
    createProvider: CodeAgentProviderFactory,
    credentials: DaemonCredentialStore,
    transportFactory: DaemonConnectionClientFactory,
    agentProxy?: AgentProxy,
    codeAgentDiscovery?: CodeAgentDiscovery,
    private readonly stateDirectory = ".coforge-daemon-state",
    private readonly lifecycle: {
      requestRestart?(requestId: string): Promise<void>;
      requestUpgrade?(requestId: string, expectedVersion?: string): Promise<void>;
      recoveredRestartRequestIds?: string[];
      recoveredUpgradeRequestIds?: string[];
      /** Terminal upgrade operations this machine still owes the server a report for. */
      recoveredUpgradeResults?: RecoveredUpgradeResult[];
      /** Called once the server has accepted a reported result. */
      acknowledgeUpgradeResult?(requestId: string): Promise<void>;
    } = {},
    private readonly computerVersion?: string,
  ) {
    this.#connection = connection;
    this.#createProvider = createProvider;
    this.#agentProcessManager = new AgentProcessManager(createProvider);
    this.#credentials = credentials;
    this.#transportFactory = transportFactory;
    this.#agentProxy = agentProxy;
    this.#codeAgentDiscovery = codeAgentDiscovery ?? defaultCodeAgentDiscovery(stateDirectory);
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
              AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
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
      cleanupUnconfirmed: (agentId, error) => this.#cleanupUnconfirmed(agentId, error),
      stop: async (agentId) => {
        const session = this.#agentProcessManager.session(agentId);
        await this.stopAgent(agentId);
        return session?.readSessionIdentity?.();
      },
      launch: async (intent, launchId, replacedSessionId, invalidateReason) => {
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
            invalidateReason,
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
      // `launchId` is always present here (minted synchronously by `AgentControl.start()`
      // before this call); the wire message and the retry's cold-start Activity
      // (`#launchAgent`'s `request.invalidateReason` narration) both follow that same,
      // effectively-unconditional signal — there is no longer a separate controlEpoch gate.
      invalidateSession: (intent, launchId, sessionId, reason) => {
        this.#transport.sendSessionInvalidate?.(
          this.#sessionInvalidateMessage(
            intent.agentId,
            intent.provider,
            sessionId,
            launchId,
            reason,
          ),
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
    if (this.#stopping || !this.#started)
      throw new AgentPreflightError(NOT_RUNNING, "DAEMON_NOT_RUNNING");
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
    if (!RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider])
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
          const transport = this.#transport;
          void this.#reportCodeAgentRuntimes(connection)
            .then((report) => {
              if (report.needsCatalogRefresh && !this.#stopping && this.#transport === transport)
                void this.#reportCodeAgentCatalogs(connection, report.runtimes, transport).catch(
                  () => {},
                );
            })
            .catch(() => {});
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
          // Best-effort, non-blocking: retries any Agent API key whose remote revoke failed
          // earlier (docs/adr/0033). Never gates readiness or the control replay above.
          this.#retryPendingAgentApiKeyRevokes();
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
        this.#transport.onAgentActivityProbe?.(
          receive(pendingControl, (probe: AgentActivityProbe) =>
            this.handleAgentActivityProbe(probe).catch((error) =>
              this.#logAgentActivityProbeFailure(probe, error),
            ),
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
      // Best-effort, non-blocking: retries any Agent API key whose remote revoke failed on a
      // previous run and survived as a pending fact (docs/adr/0033). Never gates readiness.
      this.#retryPendingAgentApiKeyRevokes();
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
      await this.#reportUpgradeResults();
      await Promise.all(
        this.#readyRunningAgentIds().map((agentId) => this.#requestReminderSnapshot(agentId)),
      );
      const codeAgentReport = await this.#reportCodeAgentRuntimes(connection).catch(
        () => undefined,
      );
      if (this.#stopping) return;
      if (codeAgentReport?.needsCatalogRefresh)
        void this.#reportCodeAgentCatalogs(connection, codeAgentReport.runtimes, transport).catch(
          () => {},
        );
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

  /**
   * Reports every terminal upgrade operation this machine has not settled yet. The server's
   * acceptance is the acknowledgement: only then does the local record become audit history.
   * A refused or failed report is left alone so the next ready handshake retries it.
   */
  async #reportUpgradeResults(): Promise<void> {
    const results = this.lifecycle.recoveredUpgradeResults ?? [];
    if (!results.length || !this.#transport.sendUpgradeResult) return;
    const connection = this.#connection;
    for (const result of results) {
      try {
        await this.#transport.sendUpgradeResult({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: result.requestId,
          workspaceId: connection.workspaceId,
          computerId: connection.computerId ?? "",
          status: result.status,
          completedAtMs: result.completedAtMs,
          ...(result.version ? { version: result.version } : {}),
          ...(result.error ? { error: result.error } : {}),
        });
        await this.lifecycle.acknowledgeUpgradeResult?.(result.requestId);
      } catch (error) {
        logger.error("Computer upgrade result report failed", {
          event: "upgrade:result_report_failed",
          request_id: result.requestId,
          workspace_id: connection.workspaceId,
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
      }
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

  /**
   * The fast half of Code Agent discovery: installed runtimes plus whatever model catalogs are
   * already on disk from a previous probe. Never spawns a provider CLI beyond what runtime
   * probing itself needs (Codex's `app-server` handshake), so this is safe to await before the
   * daemon reports itself ready to the Coordinator.
   */
  async #reportCodeAgentRuntimes(
    connection: DaemonConfig,
  ): Promise<{ runtimes: RuntimeMetadata[]; needsCatalogRefresh: boolean }> {
    const requestId = crypto.randomUUID();
    const scope = {
      request_id: requestId,
      workspace_id: connection.workspaceId,
      computer_id: connection.computerId,
    };
    try {
      const runtimes = await this.#codeAgentDiscovery.runtimes();
      const { catalogs, needsRefresh } = await this.#codeAgentDiscovery.cachedCatalogs(runtimes);
      await this.#transport.updateCodeAgents?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        runtimes,
        catalogs,
      });
      logger.info("Code Agent inventory reported", {
        event: "code_agent_inventory:reported",
        ...scope,
        runtime_count: runtimes.length,
        catalog_count: catalogs.length,
        outcome: "ok",
      });
      return { runtimes, needsCatalogRefresh: needsRefresh };
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

  /**
   * The slow half: live model catalog discovery (Kiro and Pi spawn a CLI; Codex calls
   * `model/list`). Always runs in the background, never blocking start() or a reconnect, and is
   * guarded against a daemon shutdown or a transport replaced by a later reconnect while it was
   * in flight — the same guard `onSkillsList` uses.
   */
  async #reportCodeAgentCatalogs(
    connection: DaemonConfig,
    runtimes: RuntimeMetadata[],
    transport: DaemonConnectionClient,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const scope = {
      request_id: requestId,
      workspace_id: connection.workspaceId,
      computer_id: connection.computerId,
    };
    const startedAt = performance.now();
    logger.info("Code Agent catalog discovery started", {
      event: "code_agent_catalog:summary_started",
      ...scope,
      outcome: "started",
    });
    try {
      const catalogs = await this.#codeAgentDiscovery.catalogs(runtimes);
      if (this.#stopping || this.#transport !== transport) return;
      await transport.updateCodeAgents?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        runtimes,
        catalogs,
      });
      logger.info("Code Agent catalog discovery completed", {
        event: "code_agent_catalog:summary_completed",
        ...scope,
        catalog_count: catalogs.length,
        elapsed_ms: Math.round(performance.now() - startedAt),
        outcome: "ok",
      });
    } catch (error) {
      logger.warning("Code Agent catalog discovery failed", {
        event: "code_agent_catalog:summary_failed",
        ...scope,
        elapsed_ms: Math.round(performance.now() - startedAt),
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
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
      ...controlCodeField(error),
      outcome: "failed",
    });
  }

  /** Logs a revoke failure without ever logging the key itself; the key stays in
   * #pendingAgentApiKeyRevokes and is retried on the next ready/reconnect pass or at shutdown. */
  #logAgentApiKeyRevokeFailed(agentId: string, error: unknown): void {
    logger.warning("Agent API key revoke failed", {
      event: "agent_api_key:revoke_failed",
      agent_id: agentId,
      error_code: diagnosticErrorCode(error),
      outcome: "failed",
    });
  }

  #logAgentActivityProbeFailure(probe: AgentActivityProbe, error: unknown): void {
    logger.error("Agent activity probe failed", {
      event: "agent_activity_probe:failed",
      request_id: probe.requestId,
      workspace_id: probe.workspaceId,
      computer_id: probe.computerId,
      agent_id: probe.agentId,
      probe_id: probe.probeId,
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
      ...controlCodeField(error),
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

    // A brand-new process started inside the hold window would be killed seconds later by the
    // upgrade's stop. Refusing is safe: `#agentControl.replay()` re-issues the intent after the
    // restart. Launches that only extend a live runtime returned above and are untouched.
    if (this.#runnerHold !== undefined)
      return Promise.reject(new Error(`Agent launches are held for ${this.#runnerHold}`));

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
    // The runner hold is enforced here as well as at handleAgentMessage: draining is what calls
    // AgentMessageAttentionIndex.receive, which notifies the session and then sends the
    // `agent:deliver:ack`. Not draining is therefore exactly "accepted locally, never acked", so
    // the server's AgentMessageDelivery.receivedAt stays null and it republishes after restart.
    if (
      !queue ||
      queue.closed ||
      queue.drain ||
      this.#runnerHold !== undefined ||
      !this.#agentProcessManager.session(agentId)
    )
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
    this.#interruptIfBusy(agentId, activityLaunch);
    this.#clearActivityHeartbeat(agentId);
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
    this.#clearActivityHeartbeat(agentId);
    // AgentControl's fresh retry after a kiro/pi AgentSessionRecoveryError: the invalidate was
    // already reported before this launch (see `invalidateSession` above); narrate the cold
    // start here, where the real launch's ActivityLaunch now exists. `invalidateReason` is
    // threaded explicitly through this one launch's request (see `LaunchRequest`), never a
    // side channel: it can neither outlive this launch nor attach to a later unrelated one.
    if (request.replacedSessionId && request.invalidateReason) {
      const { detail, entryText } = sessionInvalidateActivityText(
        runtimeDisplayName(config.provider),
        request.replacedSessionId,
        request.invalidateReason,
      );
      this.#emitAgentActivity(
        agentId,
        launch,
        this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE, "info", detail, {
          entries: [{ kind: "text", text: entryText }],
        }),
      );
    }
    const current = () => this.#currentActivityLaunches.get(agentId) === launch && !launch.stopping;
    let agentApiKey: string | undefined;
    let stage: "credential" | "runtime" = "credential";
    try {
      const launchConfig = await this.#requestLaunchConfig(agentId, requestId, launch, control);
      agentApiKey = launchConfig.agentApiKey;
      this.#pendingAgentApiKeyRevokes.set(agentApiKey, agentId);
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
          ? async (reportedSessionId, driverReplacedSessionId) => {
              if (!current() || this.#stopping)
                throw new Error("Agent session launch was superseded");
              // Kept for compat on the session report's own `replacedSessionId` field only
              // (unrelated to whether an invalidate is sent below): either a driver-reported
              // replacement just now, or one carried over from AgentControl's own retry.
              const replaced = driverReplacedSessionId ?? request.replacedSessionId;
              if (driverReplacedSessionId) {
                // Claude Code/Codex replace a missing native session inside the driver, with
                // no separate "before the fresh launch" moment; this callback IS the point the
                // daemon learns of it. Only a driver-reported replacement (this callback's own
                // argument, never AgentControl's carried-over `request.replacedSessionId`,
                // which was already reported once by `invalidateSession` before this launch)
                // emits here — fixes a prior bug that re-sent a second invalidate/Activity for
                // AgentControl's own retry, including harmlessly for `session_in_use`, which
                // never sets `request.replacedSessionId` together with a reason to begin with.
                // Sent BEFORE the session report below — fire-and-forget, never awaited, never
                // delays or fails the report — so the server's exact match against the still-
                // current stale session can still succeed; once the report lands below the
                // server has already moved to the new id and this would always be a no-op.
                this.#transport.sendSessionInvalidate?.(
                  this.#sessionInvalidateMessage(
                    agentId,
                    config.provider,
                    driverReplacedSessionId,
                    launch.launchId,
                    "missing",
                  ),
                );
              }
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
              if (driverReplacedSessionId) {
                const { detail, entryText } = sessionInvalidateActivityText(
                  runtimeDisplayName(config.provider),
                  driverReplacedSessionId,
                  "missing",
                );
                this.#emitAgentActivity(
                  agentId,
                  launch,
                  this.#activity(
                    agentId,
                    AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE,
                    "info",
                    detail,
                    {
                      entries: [{ kind: "text", text: entryText }],
                    },
                  ),
                );
              }
            }
          : undefined,
        reference.sessionMode,
        parseAssignedSkillPacks(launchConfig.assignedSkillPacks),
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
        void this.#revokeAgentApiKey(agentApiKey).catch((revokeError) => {
          // Local access is already revoked; the key stays pending and is retried later.
          this.#logAgentApiKeyRevokeFailed(agentId, revokeError);
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
        } catch (revokeError) {
          // Key stays in #pendingAgentApiKeyRevokes; retried on the next ready/reconnect pass.
          this.#logAgentApiKeyRevokeFailed(agentId, revokeError);
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
      if (this.#currentActivityLaunches.get(agentId) === launch) {
        this.#clearActivityHeartbeat(agentId);
        this.#currentActivityLaunches.delete(agentId);
      }
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
      if (activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS) {
        const now = Date.now();
        const last = this.#lastRuntimeProgressAt.get(agentId) ?? 0;
        if (now - last < RUNTIME_PROGRESS_RATE_LIMIT_MS) return;
        this.#lastRuntimeProgressAt.set(agentId, now);
      }
      const carriesEntries =
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING &&
        activity.entries?.some((entry) => entry.kind !== "tool_start");
      // A trajectory entry carrying a subagent scope (Claude parent_tool_use_id)
      // reports as subagent_activity regardless of its original detail kind, so
      // the display shows one unified "Subagent working…" signal (ADR 0021).
      // An error stays classified as an error so it remains visible as one.
      const subagentScoped =
        activity.level !== "error" &&
        activity.entries?.some((entry) => entry.subagent !== undefined);
      this.#emitAgentActivity(agentId, launch, {
        ...this.#activity(
          agentId,
          subagentScoped ? AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY : activity.detailKind,
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
    if (event.type === "tool-end") {
      // Liveness-only filler (ADR 0021): renews the busy lease, never stored.
      this.#emitAgentActivity(
        agentId,
        launch,
        this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.TOOL_END, "info", ""),
      );
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
        : event.status === "interrupted"
          ? this.#interruptedActivity(agentId)
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

  /**
   * Answers a server-side liveness probe with the Agent's real current activity: the remembered
   * last busy activity when one is live for the current launch, otherwise idle when the Agent is
   * launched but not busy. An Agent that is not running at all gets no reply; the process presence
   * lease already tells the server the process is gone. Never mutates any other runtime state.
   */
  async handleAgentActivityProbe(probe: AgentActivityProbe): Promise<void> {
    this.#assertOwnIntent(probe);
    const launch = this.#currentActivityLaunches.get(probe.agentId);
    if (!launch) {
      logger.info("Activity probe received for an Agent that is not running", {
        event: "agent_activity_probe:not_running",
        request_id: probe.requestId,
        workspace_id: probe.workspaceId,
        computer_id: probe.computerId,
        agent_id: probe.agentId,
        probe_id: probe.probeId,
        outcome: "skipped",
      });
      return;
    }
    const remembered = this.#lastBusyActivity.get(probe.agentId);
    if (remembered && remembered.launch === launch) {
      this.#emitAgentActivity(probe.agentId, launch, {
        ...remembered.activity,
        probeId: probe.probeId,
        entries: [],
        isHeartbeat: false,
      });
      return;
    }
    this.#emitAgentActivity(probe.agentId, launch, {
      ...this.#activity(probe.agentId, AGENT_ACTIVITY_DETAIL_KIND.IDLE, "info", ""),
      probeId: probe.probeId,
    });
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
    // Runner hold: the delivery is queued, never rejected and never indexed. Attention indexing is
    // what wakes a turn, and the server's canonical read boundary only advances when the Agent
    // itself drains `check` - so a held delivery stays undelivered server-side and is re-fetched
    // after the restart. Nothing is acknowledged while the hold is in force.
    if (this.#runnerHold !== undefined) {
      void delivery.catch(() => {});
      logger.info("Agent delivery queued behind a runner hold", {
        event: "agent.message.delivery_held",
        agent_id: message.agentId,
        delivery_id: message.deliveryId,
        reason: this.#runnerHold,
      });
      return;
    }
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
    this.#interruptIfBusy(agentId, activityLaunch);
    this.#clearActivityHeartbeat(agentId);
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

  /**
   * Stop's outcome depends only on the local process exiting (docs/adr/0033): revoking the
   * Agent API key is fire-and-forget alongside it, so a failed or slow revoke never fails or
   * delays the Stop. A key that fails to revoke stays in #pendingAgentApiKeyRevokes and is retried
   * by the next ready/reconnect pass (#retryPendingAgentApiKeyRevokes) or at shutdown.
   */
  async #releaseAgentRuntime(agentId: string, publishStopped = false): Promise<void> {
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    void this.#revokeAgentApiKey(this.#agentApiKeys.get(agentId)).catch((error) => {
      this.#logAgentApiKeyRevokeFailed(agentId, error);
    });
    await this.#agentProcessManager.stop(agentId);
    this.#messageAttention.clearAgent(agentId);
    this.#sendAgentStatus(agentId, "inactive");
    if (publishStopped && activityLaunch)
      this.#emitAgentActivity(agentId, activityLaunch, this.#stoppedActivity(agentId));
    this.#clearActivityHeartbeat(agentId);
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

  /**
   * Builds the one wire shape both `invalidateSession` emit sites send (previously constructed
   * twice, field by field). No control-fence fields (no `startRequestId`/`controlEpoch`, unlike
   * `AgentSessionReport`) — see ADR 0037, "Why no control fence fields": `launchId` is always
   * present at both call sites, so there is no separate gating condition here either.
   */
  #sessionInvalidateMessage(
    agentId: string,
    provider: RuntimeProvider,
    sessionId: string,
    launchId: string,
    reason: AgentSessionInvalidateReason,
  ): AgentSessionInvalidate {
    return {
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
      agentId,
      provider,
      sessionId,
      daemonInstanceId: this.#runtimeInstanceId,
      launchId,
      reason,
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

  /** A running turn was cut by a requested stop/restart (ADR 0021). */
  #interruptedActivity(agentId: string): ActivityDraft {
    return this.#activity(
      agentId,
      AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
      "info",
      "Agent turn was interrupted.",
    );
  }

  /** Reports runtime_interrupted when a requested stop/restart cuts a busy turn.
   * Must run before #clearActivityHeartbeat, which erases the busy evidence. */
  #interruptIfBusy(agentId: string, activityLaunch: ActivityLaunch | undefined): void {
    if (!activityLaunch) return;
    const busy = this.#lastBusyActivity.get(agentId);
    if (busy && busy.launch === activityLaunch)
      this.#emitAgentActivity(agentId, activityLaunch, this.#interruptedActivity(agentId));
  }

  /** Emits against the Agent's current launch, if one exists. */
  #emitCurrentActivity(agentId: string, activity: ActivityDraft): void {
    const launch = this.#currentActivityLaunches.get(agentId);
    if (launch) this.#emitAgentActivity(agentId, launch, activity);
  }

  #emitAgentActivity(agentId: string, launch: ActivityLaunch, activity: ActivityDraft): void {
    if (!this.#activityEnabled || this.#currentActivityLaunches.get(agentId) !== launch) return;
    if (launch.stopping) {
      this.#clearActivityHeartbeat(agentId);
      if (
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.STOPPED &&
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED &&
        activity.level !== "error" &&
        !activity.entries?.some((entry) => entry.kind !== "tool_start")
      )
        return;
    }
    this.#transport.sendAgentActivity?.({
      ...activity,
      launchId: launch.launchId,
      clientSeq: ++launch.clientSeq,
      observedAtMs: Date.now(),
    });
    if (TERMINAL_ACTIVITY_DETAIL_KINDS.has(activity.detailKind)) {
      this.#clearActivityHeartbeat(agentId);
    } else if (BUSY_ACTIVITY_DETAIL_KINDS.has(activity.detailKind)) {
      if (!activity.isHeartbeat)
        this.#lastBusyActivity.set(agentId, { launch, activity, at: Date.now() });
      this.#scheduleActivityHeartbeat(agentId, launch);
    }
  }

  /** Re-sends the last busy Activity frame every ACTIVITY_HEARTBEAT_MS so a long silent
   * turn (a shell command or a quiet model call) never lets the display lease lapse. */
  #scheduleActivityHeartbeat(agentId: string, launch: ActivityLaunch): void {
    const existing = this.#activityHeartbeatTimers.get(agentId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#activityHeartbeatTimers.delete(agentId);
      const remembered = this.#lastBusyActivity.get(agentId);
      if (!remembered || remembered.launch !== launch) return;
      this.#emitAgentActivity(agentId, launch, {
        ...remembered.activity,
        isHeartbeat: true,
        entries: [],
      });
    }, ACTIVITY_HEARTBEAT_MS);
    this.#activityHeartbeatTimers.set(agentId, timer);
  }

  #clearActivityHeartbeat(agentId: string): void {
    const timer = this.#activityHeartbeatTimers.get(agentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#activityHeartbeatTimers.delete(agentId);
    }
    this.#lastBusyActivity.delete(agentId);
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

  /**
   * Reachable only for a genuine local Stop failure (the process did not exit); a revoke failure
   * no longer reaches this path (see `#releaseAgentRuntime`).
   */
  #stopFailureMessage(agentId: string, error: unknown): string {
    if (this.#cleanupUnconfirmed(agentId, error)) return CLEANUP_UNCONFIRMED;
    return "Agent runtime could not be stopped.";
  }

  async #revokeAgentApiKey(agentApiKey: string | undefined): Promise<void> {
    if (!agentApiKey) return;
    if (!this.#transport.revokeAgentApiKey) return;
    await this.#transport.revokeAgentApiKey(agentApiKey);
    this.#pendingAgentApiKeyRevokes.delete(agentApiKey);
    for (const [agentId, current] of this.#agentApiKeys)
      if (current === agentApiKey) this.#agentApiKeys.delete(agentId);
  }

  /** Best-effort retry for keys whose revoke failed earlier; fire-and-forget so it never blocks
   * readiness. A key that keeps failing stays pending and is retried again on the next pass. */
  #retryPendingAgentApiKeyRevokes(): void {
    for (const [agentApiKey, agentId] of this.#pendingAgentApiKeyRevokes)
      void this.#revokeAgentApiKey(agentApiKey).catch((error) => {
        this.#logAgentApiKeyRevokeFailed(agentId, error);
      });
  }

  async agentMessage(
    context: string,
    request: LocalAgentMessageRequest,
    agentApiKey?: string,
  ): Promise<AgentMessageResponse> {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!this.#transport.agentMessage)
      throw new AgentPreflightError("daemon connection is not connected", "DAEMON_NOT_CONNECTED");
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
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
    if (operation === "check") return this.#checkAgentMessages(agentId, request, agentApiKey);
    if (operation === "send" && target)
      return this.#sendAgentMessage(agentId, request, target, agentApiKey);
    return this.#forwardAgentMessage(agentId, request, operation, target, agentApiKey);
  }

  /**
   * Drains the server-side events page for the Agent until it reports no more remain. The server
   * owns pagination and advances the canonical read boundary as it returns each page
   * (ack-on-drain); this loop only reconciles the daemon's volatile notice index afterward.
   */
  async #checkAgentMessages(
    agentId: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const startedAt = performance.now();
    const attention = this.#messageAttention.check(agentId);
    const messages: AgentMessageRecord[] = [];
    let hasMore = false;
    let roundCount = 0;
    while (roundCount < MAX_EVENT_DRAIN_ROUNDS) {
      roundCount += 1;
      const result = await this.#transport.agentMessage!(
        {
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: request.requestId,
          agentId,
          workspaceId: this.#connection.workspaceId,
          operation: "check",
          target: "",
          limit: request.limit,
        },
        agentApiKey,
      );
      if (!result.accepted || result.messages.length === 0) {
        hasMore = false;
        break;
      }
      messages.push(...result.messages);
      hasMore = Boolean(result.hasMore);
      if (!hasMore) break;
    }
    const maxSequenceByTarget = new Map<string, number>();
    for (const message of messages) {
      const current = maxSequenceByTarget.get(message.target) ?? 0;
      if (message.sequence > current) maxSequenceByTarget.set(message.target, message.sequence);
    }
    for (const [target, sequence] of maxSequenceByTarget) {
      this.#messageAttention.recordModelSeen(agentId, target, sequence);
      this.#messageAttention.recordReadContext(agentId, target);
    }
    logger.info("Agent checked pending messages", {
      event: "agent.message.checked",
      ...this.#agentLogScope(agentId, request.requestId),
      pending_count: attention.reduce((count, item) => count + item.pendingCount, 0),
      displayed_count: messages.length,
      round_count: roundCount,
      has_more: hasMore,
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
      hasMore,
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
    if (request.sendDraft && !draft)
      throw new AgentPreflightError(`No held draft for target: ${target}`, "NO_HELD_DRAFT");
    const body = draft?.body ?? request.body;
    if (body === undefined)
      throw new AgentPreflightError(
        "Agent message body is required",
        "AGENT_MESSAGE_BODY_REQUIRED",
      );
    // `--send-draft` re-sends the saved draft's attachments/mentions unless the Agent explicitly
    // supplies new `--mention` values, which replace them (Feature 2's documented override).
    const attachmentIds = request.sendDraft ? draft?.attachmentIds : request.attachmentIds;
    const mentions = request.sendDraft
      ? request.mentions?.length
        ? request.mentions
        : draft?.mentions
      : request.mentions;
    // Raft-aligned: the presence check runs against the EFFECTIVE outgoing content on every path,
    // including a `--send-draft` resend of the daemon-held body (the CLI can only run this check
    // client-side when it has the body in hand, i.e. never for an unmodified draft resend).
    if (mentions?.length) {
      const present = mentionsInContent(body);
      for (const mention of mentions)
        if (!present.has(mention.name))
          throw new AgentPreflightError(
            `Structured mention @${mention.name} is not present in the message body.`,
            "MENTION_NOT_IN_CONTENT",
          );
    }
    // Narrow local guard, decided entirely from volatile read-context state, before any transport
    // call is made: a top-level send whose parent was read less recently than a thread rooted
    // under it is an easy typo (replying to the channel instead of the thread), and moving a
    // thread conclusion to the parent channel is uncommon enough to confirm once. `--send-draft`
    // itself skips this guard (it can only re-target what was already confirmed once, at worst).
    if (
      !request.sendDraft &&
      !request.targetConfirmed &&
      threadParentTarget(target) === undefined
    ) {
      const latestThread = this.#messageAttention.latestThreadReadUnderParent(agentId, target);
      if (latestThread) {
        const parentOrder = this.#messageAttention.readOrder(agentId, target);
        if (parentOrder === undefined || parentOrder < latestThread.order) {
          // Raft-aligned: the outgoing content is saved as the local draft (no holdToken) before
          // refusing, so the documented recovery is resending that exact draft, not retyping it.
          await inbox.save(target, body, attachmentIds, mentions);
          throw new AgentPreflightError(
            targetConfirmationRequiredMessage(target, latestThread.target),
            "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
            true,
          );
        }
      }
    }
    // `inbox.save` persists the draft locally BEFORE the request is issued to the transport below;
    // any failure past this point leaves delivery state unknown, never "not sent" (see
    // `agent-preflight-error.ts` / `agent-proxy-failure.ts` and `message send`'s CLI renderer).
    if (!request.sendDraft) await inbox.save(target, body, attachmentIds, mentions);
    // A tokenless draft (saved by the guard above, or by a failed transport before ever reaching a
    // hold) resends as a plain send: no holdToken to send, and nothing for `--anyway` to bypass.
    if (request.sendDraft && !draft?.holdToken && request.continueAnyway)
      throw new AgentPreflightError(
        `Held draft token is unavailable for target: ${target}`,
        "HELD_DRAFT_TOKEN_UNAVAILABLE",
      );
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
        attachmentIds: attachmentIds ? [...attachmentIds] : undefined,
        mentions: mentions ? [...mentions] : undefined,
      },
      agentApiKey,
    );
    const held = result.sideEffectDecision === "hold";
    if (held && result.holdToken)
      await inbox.replace(target, body, result.holdToken, attachmentIds, mentions);
    else if (result.accepted) await inbox.clear(target);
    const withheld = request.freshnessContextMode === "withheld";
    const targetMessages = result.messages.filter((message) => message.target === target);
    if (!withheld && targetMessages.length > 0) {
      this.#messageAttention.recordModelSeen(
        agentId,
        target,
        Math.max(...targetMessages.map(({ sequence }) => sequence)),
      );
      // The held-context read inside `send`: the Agent just consumed these messages for `target`.
      this.#messageAttention.recordReadContext(agentId, target);
    }
    const recentUnread = withheld
      ? []
      : (result.recentUnread ?? []).filter((message) => message.target === target);
    if (recentUnread.length > 0)
      this.#messageAttention.recordModelSeen(
        agentId,
        target,
        Math.max(...recentUnread.map(({ sequence }) => sequence)),
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
      recentUnread,
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
    // The `--target-confirmed` guard's read-context tracking: any successful `read` (anchored or
    // not) counts as the Agent having consumed messages for `target`.
    if (operation === "read" && target && result.accepted)
      this.#messageAttention.recordReadContext(agentId, target);
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

  async githubCredential(
    context: string,
    request: GitHubCredentialRequest,
    agentApiKey?: string,
  ): Promise<GitHubCredentialResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.githubCredential)
      throw new Error("GitHub credential endpoint is not configured");
    return this.#transport.githubCredential(request, agentApiKey);
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

  /** Dispatches a channel lifecycle/roster command to the cloud route `agentChannel` maps it
   * to, returning the JSON response body unchanged. */
  async agentChannel(
    context: string,
    command: ChannelCommand,
    agentApiKey?: string,
  ): Promise<Record<string, unknown>> {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!this.#transport.agentChannel) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    return this.#transport.agentChannel(
      {
        ...command,
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        workspaceId: this.#connection.workspaceId,
        agentId,
      },
      agentApiKey,
    );
  }

  /**
   * Posts an Agent-prepared action card (`coforge action prepare`). Unlike `agentTask`, the wire
   * request carries no `workspaceId`/`agentId` — the HTTPS route derives the principal from the
   * authenticated Agent/daemon API key pair, exactly like an ordinary Agent message send.
   */
  async agentActionPrepare(
    context: string,
    request: AgentActionPrepareRequest,
    agentApiKey?: string,
  ): Promise<AgentActionPrepareResponse> {
    this.#assertRunning();
    this.#agentIdForContext(context);
    if (!this.#transport.agentActionPrepare) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    return this.#transport.agentActionPrepare(request, agentApiKey);
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

  async agentWeeklyReport(
    context: string,
    command: WeeklyReportCommand,
    agentApiKey?: string,
  ): Promise<WeeklyReportResponse> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    const agentId = [...this.#agentContexts.entries()].find(([, value]) => value === context)?.[0];
    if (!agentId) throw new Error("invalid agent local context");
    if (!this.#transport.agentWeeklyReport) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    return this.#transport.agentWeeklyReport(
      {
        ...command,
        protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        workspaceId: this.#connection.workspaceId,
        agentId,
      },
      agentApiKey,
    );
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
    if (!agentId)
      throw new AgentPreflightError("invalid agent local context", "AGENT_CONTEXT_INVALID");
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

  async agentAttachmentUpload(
    context: string,
    request: Request,
    agentApiKey?: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUpload)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUpload(request, agentApiKey);
  }

  async agentAttachmentUploadSessionCreate(
    context: string,
    body: unknown,
    agentApiKey?: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUploadSessionCreate)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUploadSessionCreate(body, agentApiKey);
  }

  async agentAttachmentUploadSessionComplete(
    context: string,
    uploadId: string,
    agentApiKey?: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUploadSessionComplete)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUploadSessionComplete(uploadId, agentApiKey);
  }

  async agentAttachmentUploadSessionCancel(
    context: string,
    uploadId: string,
    agentApiKey?: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUploadSessionCancel)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUploadSessionCancel(uploadId, agentApiKey);
  }

  async agentAttachmentUploadSessionGet(
    context: string,
    uploadId: string,
    agentApiKey?: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUploadSessionGet)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUploadSessionGet(uploadId, agentApiKey);
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

  /**
   * Stops admitting new Agent turns and reports which Agents are still busy. Idempotent: a repeat
   * call only re-reads the busy set, which is what the upgrade's quiescence poll relies on.
   */
  holdRunners(reason = "upgrade"): BusyAgentReport[] {
    if (this.#runnerHold === undefined)
      logger.info("Runner hold engaged", { event: "daemon.runner_hold.engaged", reason });
    this.#runnerHold = reason;
    return this.busyAgents();
  }

  /** Lifts the hold and resumes every delivery queued behind it, in arrival order. */
  releaseRunners(): BusyAgentReport[] {
    if (this.#runnerHold !== undefined)
      logger.info("Runner hold released", {
        event: "daemon.runner_hold.released",
        reason: this.#runnerHold,
      });
    this.#runnerHold = undefined;
    // Copied deliberately: #ensureAgentInputDrain deletes drained queues from this very map.
    const queued = Array.from(this.#agentInputQueues.keys());
    for (const agentId of queued) this.#ensureAgentInputDrain(agentId);
    return this.busyAgents();
  }

  get runnerHeld(): boolean {
    return this.#runnerHold !== undefined;
  }

  /**
   * Agents whose last emitted Activity is a busy detail kind with no terminal kind since -
   * `#lastBusyActivity` is set on every busy emission and cleared by `#clearActivityHeartbeat`,
   * which every terminal kind and every stop path already runs (ADR 0016).
   */
  busyAgents(): BusyAgentReport[] {
    return [...this.#lastBusyActivity.entries()].map(([agentId, remembered]) => ({
      agentId,
      detailKind: remembered.activity.detailKind,
      busySinceMs: remembered.at,
    }));
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#runnerHold = undefined;
    // Close every local capability synchronously before any shutdown await.
    this.#stopping = true;
    this.#started = false;
    this.#activityEnabled = false;
    for (const timer of this.#activityHeartbeatTimers.values()) clearTimeout(timer);
    this.#activityHeartbeatTimers.clear();
    this.#lastBusyActivity.clear();
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
    // Revoke stays best-effort at shutdown too (docs/adr/0033): Stop's outcome above already
    // depended only on the local process, and a stuck revoke must never fail teardown or leave
    // a key un-retried. A key that fails here stays pending; the next daemon's ready/reconnect
    // pass retries it (in-memory only — a full process restart naturally drops the local set,
    // same as every other in-memory runtime fact).
    await Promise.all(
      [...this.#pendingAgentApiKeyRevokes].map(([agentApiKey, agentId]) =>
        this.#revokeAgentApiKey(agentApiKey).catch((error) => {
          this.#logAgentApiKeyRevokeFailed(agentId, error);
        }),
      ),
    );
    try {
      await this.#transport.stop();
    } catch (error) {
      shutdownError ??= error;
    }
    // Keep the same transport instance while a revoke is still pending: it already carries the
    // authenticated token/serverHttpUrl a revoke retry needs (`#agentApiKeyRequest`), and that HTTP
    // path does not depend on the WSS client `.stop()` just tore down. Recreating early would hand
    // the retry an unauthenticated transport instead. Once every pending key is cleared, recreate
    // so a later start() never reuses a transport that went through `.stop()`.
    if (this.#pendingAgentApiKeyRevokes.size === 0) {
      this.#transport = this.#transportFactory.create(this.#connection);
    }
    if (shutdownError !== undefined) throw shutdownError;
  }
}

function safeRuntimeActivityMessage(activity: string, level: string, message: string): string {
  if (level === "error") return message.slice(0, 512);
  if (level === "warning") return scrubActivityText(message);
  if (activity === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS) return "";
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
