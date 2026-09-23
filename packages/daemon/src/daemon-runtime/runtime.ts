import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  UsageUnavailableError,
  UsageUnsupportedError,
  AgentContextReportTimeoutError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type UsageSnapshot,
} from "#src/code-agent/contract";
import { mkdirSync } from "node:fs";
import { readOperatingSystem } from "#src/platform/operating-system";
import { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import { CompactionTracker } from "#src/agent-runtime/compaction-tracker";
import { RuntimeProgressTracker } from "#src/agent-runtime/runtime-progress";
import {
  buildRuntimeErrorActivity,
  buildRuntimeCrashedActivity,
  buildRuntimeReconnectingActivity,
  scrubRuntimeErrorText,
  fingerprintRuntimeError,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import {
  classifyRuntimeErrorText,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClassification,
} from "#src/agent-runtime/runtime-error-classification";
import {
  RuntimeErrorDeliveryBackoff,
  RuntimeErrorFingerprintFence,
  runtimeErrorFingerprintFenceDetail,
  type RuntimeErrorFingerprintFenceState,
} from "#src/agent-runtime/runtime-error-recovery";
import {
  AgentProcessManager,
  type CodeAgentProviderFactory,
  type AgentRuntime,
} from "#src/agent-runtime/agent-process-manager";
import { parseAssignedSkillPacks } from "#src/code-agent/assigned-skills";
import { launchCategoryText, launchFailureTrace } from "#src/agent-runtime/launch-failure";
import { agentRuntimeContextEnvironment } from "#src/code-agent/environment";
import { toolActivity } from "#src/code-agent/tool-activity";
export type DaemonConfig = {
  workspaceId: string;
  computerId: string;
  workspaceRoot: string;
  serverHttpUrl?: string;
};
/** @deprecated wire-facing callers should use DaemonConfig internally. */
export type WorkspaceConfig = DaemonConfig;
import type { DaemonCredentialStore } from "#src/credentials/credential-store";
import type {
  DaemonConnectionClient,
  DaemonConnectionClientFactory,
} from "#src/connection/daemon-connection";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  AGENT_ACTIVITY_DETAIL_KIND,
  truncateCodePoints,
  type AgentActivity,
  type AgentSessionInvalidate,
  type AgentSessionInvalidateReason,
  type AgentMessageRecord,
  type AgentMessageResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  type AgentStartIntent,
  type AgentStopIntent,
  type SessionIdentity,
  type AgentActivityProbe,
  type AgentWorkspaceResetRequest,
  type AgentMessageDelivery,
  type InboxResponse,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  RUNTIME_PROVIDER,
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
  parseUpgradeErrorCode,
  type AgentWorkspaceFilesListRequest,
  type AgentWorkspaceFilesListResult,
  type AgentWorkspaceFileReadRequest,
  type AgentWorkspaceFileReadResult,
  type AgentContextScanRequest,
  type AgentContextScanResponse,
  AGENT_CONTEXT_SCAN_STATUS,
  AGENT_MESSAGE_ACK_METHOD,
  freshnessDecisionFactId,
} from "@lrm/coforge-sdk/internal";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { memoryIndexReminder } from "#src/agent-runtime/agent-memory-seed";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState } from "#src/agent-runtime/agent-runtime-state";
import { MemoryAgentRuntimeStateStore } from "#src/persistence/memory-agent-runtime-state-store";
import { listAgentSkills } from "#src/code-agent/agent-skills";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "#src/agent-runtime/agent-workspace-files";
import { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { AgentDeliveryQueue } from "./agent-delivery-queue";
import { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import {
  HELD_CONTEXT_LIMIT,
  locallyHeldSend,
  planAgentInboxFreshness,
} from "./agent-inbox-freshness";
import { heldFreshnessActivity, heldFreshnessMessageCount } from "./agent-inbox-freshness-activity";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import { AgentAppInbox, type MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import { AgentPreflightError } from "./agent-preflight-error";
import {
  discoverCodeAgentRuntimes,
  discoverCodeAgentCatalogs,
  loadCachedCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { getLogger } from "@logtape/logtape";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { ReminderScheduler, reminderAppInboxPreview } from "#src/agent-reminder/reminder-scheduler";
import { FileReminderReceiptStore } from "#src/persistence/reminder-receipt-store";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";
import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  GitHubCredentialRequest,
  GitHubCredentialResponse,
  GitHubCommitTrailersRequest,
  GitHubCommitTrailersResponse,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentVersionResponse,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
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
  /** See `UPGRADE_ERROR_CODE`. */
  errorCode?: string;
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
  // The server mints and supplies launchId for every managed start; a managed
  // intent that somehow arrives without one is a protocol bug, not a normal race.
  "agent_launch_id_required",
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

/** Whether a recovery context has anything concrete to deliver. `recoveryOf(intent)` always
 * returns an object, even for a launch with no wake message, resume messages, or unread summary,
 * so callers cannot tell "nothing to recover" from "recovery was requested" by presence alone —
 * this is the same check `#recoverAttention` uses to skip an empty context, reused by the
 * startup turn below so the two never both fire for one launch. */
function recoveryHasContent(context: AgentRecoveryContext | undefined): boolean {
  return Boolean(
    context &&
    (context.wakeMessage ||
      context.resumeMessages?.length ||
      Object.keys(context.unreadSummary ?? {}).length),
  );
}

/** The fixed input of a startup turn: a launch that creates a new native session with nothing to
 * recover opens its first turn with it, so the standing "Startup sequence" instructions run. */
export const AGENT_STARTUP_TURN_TEXT = "Start.";

type AgentInput =
  | { kind: "recovery"; context: AgentRecoveryContext; completion: AgentInputCompletion }
  | { kind: "delivery"; message: AgentMessageDelivery; completion: AgentInputCompletion }
  | { kind: "startup"; completion: AgentInputCompletion };

type AgentInputQueue = {
  items: AgentInput[];
  drain?: Promise<void>;
  closed: boolean;
};

type ActivityLaunch = {
  launchId: string;
  clientSeq: number;
  stopping: boolean;
  // The most recent `error` event not yet resolved by a `completed` event, if any (cleared on
  // `completed`). Read by the process-exit handler to decide `runtime_crashed` vs `idle` wording
  // — `AgentSession.onExit` itself carries no exit code/signal, so this is the only fact the
  // core has for that decision (see agent-runtime/runtime-error-activity.ts).
  crashDetail?: RuntimeErrorEvent;
};

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
  // Liveness-only fillers: busy, but content-free.
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED,
  // Visible, stored busy detail kinds.
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT,
  AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY,
  AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY,
  AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
]);

/** How many recently handled send request ids per Agent+target the draft bookkeeping remembers.
 * A transport retry re-runs the same request id, so remembering the last few is what lets the
 * daemon tell a replay of an older send from a fresh one (task #70). */
const DRAFT_REPLAY_MEMORY = 8;

/** Per Agent+target draft bookkeeping, kept in memory only: the draft file itself stays exactly
 * Raft's `continue-state.json` shape, so no bookkeeping field leaks onto disk. */
type AgentDraftBookkeeping = {
  /** The request whose content the target's current draft holds; only it may clear that draft. */
  ownerRequestId?: string;
  /** Recently handled send request ids for this target, oldest first. */
  seenRequestIds: string[];
};

/** Detail kinds that end a busy turn; the heartbeat stops as soon as one is observed. */
const TERMINAL_ACTIVITY_DETAIL_KINDS = new Set<string>([
  AGENT_ACTIVITY_DETAIL_KIND.IDLE,
  AGENT_ACTIVITY_DETAIL_KIND.STOPPED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
  AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED,
]);

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
const RUNTIME_DISPLAY_NAME: Record<RuntimeProvider, string> = {
  [RUNTIME_PROVIDER.CODEX]: "Codex",
  [RUNTIME_PROVIDER.CLAUDE_CODE]: "Claude Code",
  [RUNTIME_PROVIDER.KIRO]: "Kiro",
  [RUNTIME_PROVIDER.CURSOR]: "Cursor CLI",
  [RUNTIME_PROVIDER.OPENCODE]: "OpenCode",
  [RUNTIME_PROVIDER.GROK]: "Grok Build",
  [RUNTIME_PROVIDER.PI]: "Pi",
  [RUNTIME_PROVIDER.COFORGE]: "CoForge",
};
function runtimeDisplayName(provider: RuntimeProvider): string {
  return RUNTIME_DISPLAY_NAME[provider];
}

/** Raft narrates an activity for exactly its two hold decisions; a send that reached the provider
 * (`forward`/`bypass`) has none. */
function heldFreshnessDecision(
  decision: string | undefined,
): "local_hold" | "syncing_hold" | undefined {
  return decision === "local_hold" || decision === "syncing_hold" ? decision : undefined;
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
  /** One Workspace Files list/read at a time per daemon, mirroring `#skillsScanning`. */
  #workspaceFilesScanning = false;
  /** Serializes on-demand model-catalog refreshes (one CLI-spawning discovery at a time), like
   * Raft's `refreshChain`. */
  #modelRefreshChain: Promise<void> = Promise.resolve();
  readonly #messageAttention: AgentMessageAttentionIndex;
  /** Busy-gated delivery holding for providers with no safe busy path. */
  readonly #deliveryQueue = new AgentDeliveryQueue();
  /** Per-Agent retryable-runtime-error bookkeeping: consecutive-failure delivery
   * backoff and the same-fingerprint repeat fence — see agent-runtime/runtime-error-recovery.ts. */
  readonly #runtimeErrorDeliveryBackoff = new RuntimeErrorDeliveryBackoff();
  readonly #runtimeErrorFingerprintFence = new RuntimeErrorFingerprintFence();
  /** The one pending delivery-backoff release timer per Agent, if any. */
  readonly #runtimeErrorBackoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reminders: ReminderScheduler;
  readonly #agentInboxes = new Map<string, AgentInboxStateMachine>();
  readonly #draftBookkeeping = new Map<string, Map<string, AgentDraftBookkeeping>>();
  readonly #appInboxes = new Map<string, Promise<AgentAppInbox>>();
  readonly #notifiedAppItems = new Map<string, Map<string, Promise<boolean>>>();
  readonly #runtimeInstanceId = generateRuntimeInstanceId();
  readonly #startedAt = Date.now();
  readonly #agentContexts = new Map<string, string>();
  readonly #agentProxyTokens = new Map<string, string>();
  readonly #agentApiKeys = new Map<string, string>();
  /** Agents launched with the weekly-report-collect skill pack (ADR 0032). */
  readonly #collectSkillAgents = new Set<string>();
  readonly #agentLaunches = new Map<string, Promise<AgentRuntime>>();
  readonly #sessionReferences = new Map<
    string,
    {
      requestId: string;
      provider: AgentRuntimeConfig["provider"];
      sessionId?: string;
      sessionMode?: SessionMode;
      launchId?: string;
      /** The control epoch of the request this reference was last launched/rebound under;
       * read live by `#launchAgent`'s `reportAgentSession` closure (via this
       * same object, mutated in place by `#rebindAgent`, never replaced) so a session report
       * sent after a rebind carries the new epoch instead of the one captured at launch time. */
      controlEpoch?: number;
    }
  >();
  readonly #agentInputQueues = new Map<string, AgentInputQueue>();
  readonly #stoppingAgents = new Set<string>();
  readonly #agentStops = new Map<string, Promise<void>>();
  readonly #currentActivityLaunches = new Map<string, ActivityLaunch>();
  readonly #agentStatusSequences = new Map<string, number>();
  readonly #observedUsage = new Map<RuntimeProvider, UsageSnapshot>();
  /** The last (usedTokens, windowTokens) reading sent per Agent, so an unchanged
   * reading is not re-sent. Forgotten on launch end/dispose, alongside `#compactionTracker`. */
  readonly #lastContextUsage = new Map<string, { usedTokens: number; windowTokens: number }>();
  readonly #agentProxy?: AgentProxy;
  readonly #activityHeartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #lastBusyActivity = new Map<
    string,
    { launch: ActivityLaunch; activity: ActivityDraft; at: number }
  >();
  /** Runner-hold reason while this runtime is refusing new turns; undefined when not held.
   * Deliberately in-memory only, so a restarted daemon is never born held. */
  #runnerHold: string | undefined;
  /** Whether a compaction is in flight per Agent, and its 5-minute stale watchdog - see
   * agent-runtime/compaction-tracker.ts. Providers only report the raw start/finish/interrupted
   * signal; this decides what, if anything, that becomes on the wire. */
  readonly #compactionTracker = new CompactionTracker((agentId) => {
    // TODO(compaction_stale): the SDK's AgentActivityDetailKind does not yet carry a
    // `compaction_stale` value (landing in a separate change). Once it does, broadcast it here:
    //   const launch = this.#currentActivityLaunches.get(agentId);
    //   if (launch) this.#emitAgentActivity(agentId, launch, this.#activity(agentId,
    //     AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE, "info",
    //     "Compaction is still running; no finish signal was observed."));
    void agentId;
  });
  /** Liveness bookkeeping for the content-free "progress" signal - see
   * agent-runtime/runtime-progress.ts. */
  readonly #runtimeProgress = new RuntimeProgressTracker();
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
      /** Terminal upgrade operations this machine still owes the server a report for, as known
       * at construction time. */
      recoveredUpgradeResults?: RecoveredUpgradeResult[];
      /**
       * Re-reads terminal operations from durable local config on reconnect. The normal upgrade
       * path commits and injects terminal state before this process starts; this hook is only the
       * crash-recovery fallback when a Coordinator settles an older operation later.
       */
      refreshUpgradeResults?(): Promise<RecoveredUpgradeResult[]>;
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
      {
        shouldHold: (agentId) => this.#deliveryQueue.shouldHold(agentId),
        queued: (agentId) => this.#deliveryQueue.pending(agentId),
        enqueue: (agentId, message) => this.#deliveryQueue.enqueue(agentId, message),
        busy: (agentId) => this.#deliveryQueue.busy(agentId),
        // The consumed cursor outlives the process, in Raft's `consumed-seqs.json` shape: what an
        // Agent has already reviewed decides the next hold, the `seenUpToSeq` a fresh send inherits,
        // and whether a top-level send under a thread-read parent needs confirming. It lives beside
        // the draft store in the temporary state root, not in this daemon's state directory.
        consumedSeqs: new AgentConsumedSeqStore(),
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
      // Control state lives only in this process: the server
      // re-dispatches what should still be running after a restart, so a persisted record could
      // only outlive the writer it was waiting on.
      new MemoryAgentRuntimeStateStore(connection.workspaceRoot, connection.workspaceId),
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
      rebind: (intent, launchId) => this.#rebindAgent(intent, launchId),
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
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
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
    // The one place a scan result gets its `collectedAt`: a fresh reading is stamped "now"; an
    // observed snapshot reused from `#currentObservedUsage` already carries the time it was
    // observed (`#rememberUsage` stamps that), which this must not overwrite.
    const stamp = (snapshot: UsageSnapshot): UsageSnapshot =>
      snapshot.collectedAt ? snapshot : { ...snapshot, collectedAt: new Date().toISOString() };
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
        ? result("available", stamp(snapshot))
        : result("reauth", undefined, "Provider usage is unavailable");
    } catch (error) {
      // A non-subscription account has no plan usage at all — answering `unsupported` wins
      // over a stale observed snapshot, which a reading like this can never have produced.
      if (error instanceof UsageUnsupportedError)
        return result("unsupported", undefined, "Usage scanning is unsupported for this account");
      const snapshot = this.#currentObservedUsage(provider);
      if (snapshot) return result("available", stamp(snapshot));
      return error instanceof UsageUnavailableError
        ? result("unavailable", undefined, "Provider usage is unavailable")
        : result("error", undefined, "Usage scan failed");
    }
  }

  /**
   * Answers a server-requested breakdown of one Agent's current Claude Code context-window
   * composition. Unlike `scanUsage` (provider-wide), this is per-Agent: it resolves the
   * Agent's own current launch and native session id from what this runtime already tracks
   * (`#currentActivityLaunches`, `#sessionReferences` — the same references `#sendContextUsage`
   * reads), never trusting `request.launchId`/`request.sessionId` to run anything; those fields are
   * only echoed back for correlation, or used to detect a request naming a launch this runtime has
   * already superseded (`error`, without running the CLI). Check order: not running ->
   * `no_session`; a stale launch -> `error`; the provider has no `readContextReport` ->
   * `unsupported`; no native session id yet -> `no_session`; otherwise the CLI runs.
   */
  async scanAgentContext(request: AgentContextScanRequest): Promise<AgentContextScanResponse> {
    this.#assertRunning();
    this.#assertOwnIntent(request);
    const base = {
      protocolMajor: request.protocolMajor,
      requestId: request.requestId,
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
      agentId: request.agentId,
      provider: request.provider,
    };
    const result = (
      launchId: string,
      sessionId: string,
      status: AgentContextScanResponse["status"],
      reportJson?: Uint8Array,
      message?: string,
    ): AgentContextScanResponse => ({
      ...base,
      launchId,
      sessionId,
      accepted: Boolean(reportJson),
      status,
      ...(reportJson ? { reportJson } : {}),
      ...(message ? { message } : {}),
    });
    const launch = this.#currentActivityLaunches.get(request.agentId);
    if (!launch)
      return result(request.launchId, request.sessionId, AGENT_CONTEXT_SCAN_STATUS.NO_SESSION);
    if (request.launchId && launch.launchId !== request.launchId)
      return result(
        launch.launchId,
        request.sessionId,
        AGENT_CONTEXT_SCAN_STATUS.ERROR,
        undefined,
        "Agent context scan targets a superseded launch",
      );
    const config = this.#agentProcessManager.runtime(request.agentId)?.config;
    if (!config)
      return result(launch.launchId, request.sessionId, AGENT_CONTEXT_SCAN_STATUS.NO_SESSION);
    const codeAgentProvider = this.#createProvider(config.provider);
    if (!codeAgentProvider.readContextReport)
      return result(launch.launchId, request.sessionId, AGENT_CONTEXT_SCAN_STATUS.UNSUPPORTED);
    const sessionId = this.#sessionReferences.get(request.agentId)?.sessionId;
    if (!sessionId)
      return result(launch.launchId, request.sessionId, AGENT_CONTEXT_SCAN_STATUS.NO_SESSION);
    try {
      const report = await codeAgentProvider.readContextReport({
        workingDirectory: agentWorkspaceDirectory(
          this.#connection.workspaceRoot,
          this.#connection.workspaceId,
          request.agentId,
        ),
        sessionId,
        timeoutMs: 20_000,
      });
      return report
        ? result(
            launch.launchId,
            sessionId,
            AGENT_CONTEXT_SCAN_STATUS.AVAILABLE,
            new TextEncoder().encode(JSON.stringify(report)),
          )
        : result(launch.launchId, sessionId, AGENT_CONTEXT_SCAN_STATUS.UNPARSED);
    } catch (error) {
      return error instanceof AgentContextReportTimeoutError
        ? result(launch.launchId, sessionId, AGENT_CONTEXT_SCAN_STATUS.TIMEOUT)
        : result(
            launch.launchId,
            sessionId,
            AGENT_CONTEXT_SCAN_STATUS.ERROR,
            undefined,
            "Context scan failed",
          );
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
          // Normal promotion puts terminal state in this process's initial config. Reconnect
          // still re-reads config as crash recovery for an older operation settled later.
          void this.#reportUpgradeResults().catch(() => {});
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
        transport.onWorkspaceFilesList?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          const result = await this.#listWorkspaceFiles(connection, request);
          if (!this.#stopping && this.#transport === transport)
            await transport.sendWorkspaceFilesListResult?.({ ...request, ...result });
        }),
      );
      this.#subscribe(
        transport.onWorkspaceFileRead?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          const result = await this.#readWorkspaceFile(connection, request);
          if (!this.#stopping && this.#transport === transport)
            await transport.sendWorkspaceFileReadResult?.({ ...request, ...result });
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
      this.#subscribe(
        this.#transport.onProviderModelRefresh?.(async (request) => {
          if (this.#stopping || request.computerId !== connection.computerId) return;
          // Serialize: each request gets a real discovery, in arrival order, never overlapping.
          this.#modelRefreshChain = this.#modelRefreshChain
            .catch(() => {})
            .then(() => this.#refreshProviderModels(connection, request, transport));
          await this.#modelRefreshChain;
        }),
      );
      this.#subscribe(
        this.#transport.onAgentContextScan?.(async (request) => {
          if (request.computerId !== connection.computerId) return;
          const result = await this.scanAgentContext(request);
          await this.#transport.sendAgentContextScanResult?.(result);
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
        requestUpgrade: this.lifecycle.requestUpgrade
          ? (requestId, expectedVersion) => this.#requestUpgrade(requestId, expectedVersion)
          : undefined,
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
   * Wraps `lifecycle.requestUpgrade` (the local call into the Coordinator): when it rejects -
   * refused (a pending operation, launches paused) or the launch itself failing - this Workspace
   * still owes the server an immediate, reasoned failure report. Without this, the caller
   * (`DaemonConnection#acceptLifecycleRequest`) just swallows the rejection and the server is
   * left waiting until it times out with a generic "did not report in time", even though this
   * machine knew exactly why. Reported through the same wire
   * message and dedupe `#reportUpgradeResults` uses (`#transport.sendUpgradeResult`), so a retry
   * of the same request cannot double-report. Rethrown so the caller's existing
   * dedupe-clearing behaviour on a rejection is unaffected.
   */
  async #requestUpgrade(requestId: string, expectedVersion?: string): Promise<void> {
    const requestUpgrade = this.lifecycle.requestUpgrade;
    if (!requestUpgrade) throw new Error("upgrade requests are unsupported");
    try {
      await requestUpgrade(requestId, expectedVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = parseUpgradeErrorCode((error as { code?: unknown } | null)?.code);
      logger.warn("Computer upgrade request was refused", {
        event: "upgrade:request_refused",
        request_id: requestId,
        workspace_id: this.#connection.workspaceId,
        error_code: errorCode ?? diagnosticErrorCode(error),
        error_message: message,
      });
      await this.#transport
        .sendUpgradeResult?.({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId,
          workspaceId: this.#connection.workspaceId,
          computerId: this.#connection.computerId ?? "",
          status: "failed",
          completedAtMs: Date.now(),
          error: message,
          ...(errorCode ? { errorCode } : {}),
        })
        .catch((reportError) => {
          logger.error("Refused Computer upgrade could not be reported", {
            event: "upgrade:refusal_report_failed",
            request_id: requestId,
            workspace_id: this.#connection.workspaceId,
            error_code: diagnosticErrorCode(reportError),
          });
        });
      throw error;
    }
  }

  /**
   * Reports every terminal upgrade operation this machine has not settled yet. The server's
   * acceptance is the acknowledgement: only then does the local record become audit history.
   * A refused or failed report is left alone so the next ready handshake retries it.
   */
  async #reportUpgradeResults(): Promise<void> {
    const results = this.lifecycle.refreshUpgradeResults
      ? await this.lifecycle
          .refreshUpgradeResults()
          .catch(() => this.lifecycle.recoveredUpgradeResults ?? [])
      : (this.lifecycle.recoveredUpgradeResults ?? []);
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
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
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

  async #listWorkspaceFiles(
    connection: DaemonConfig,
    request: Pick<AgentWorkspaceFilesListRequest, "agentId" | "dirPath" | "includeHidden">,
  ): Promise<Pick<AgentWorkspaceFilesListResult, "status" | "rootPath" | "entries">> {
    const unavailable = { status: "error" as const, rootPath: "", entries: [] };
    if (this.#workspaceFilesScanning) return unavailable;
    this.#workspaceFilesScanning = true;
    try {
      return await listAgentWorkspaceFiles({
        agentWorkspaceDirectory: agentWorkspaceDirectory(
          connection.workspaceRoot,
          connection.workspaceId,
          request.agentId,
        ),
        dirPath: request.dirPath,
        includeHidden: request.includeHidden,
      });
    } catch {
      // Return safe diagnostics, never file contents or raw filesystem errors.
      return unavailable;
    } finally {
      this.#workspaceFilesScanning = false;
    }
  }

  async #readWorkspaceFile(
    connection: DaemonConfig,
    request: Pick<AgentWorkspaceFileReadRequest, "agentId" | "path">,
  ): Promise<
    Pick<
      AgentWorkspaceFileReadResult,
      "status" | "sizeBytes" | "modifiedAtMs" | "text" | "contentType" | "contentBase64"
    >
  > {
    const unavailable = {
      status: "error" as const,
      sizeBytes: 0,
      modifiedAtMs: 0,
      text: "",
      contentType: "",
      contentBase64: "",
    };
    if (this.#workspaceFilesScanning) return unavailable;
    this.#workspaceFilesScanning = true;
    try {
      return await readAgentWorkspaceFile({
        agentWorkspaceDirectory: agentWorkspaceDirectory(
          connection.workspaceRoot,
          connection.workspaceId,
          request.agentId,
        ),
        path: request.path,
      });
    } catch {
      // Return safe diagnostics, never file contents or raw filesystem errors.
      return unavailable;
    } finally {
      this.#workspaceFilesScanning = false;
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
   * On-demand model-catalog re-discovery, driven by the server's `daemon:v1:provider:model_refresh`
   * request (the browser's model selector asks for it). Re-runs the same live discovery the
   * background refresh uses, re-reports through the ordinary inventory update so the server's copy
   * is current, then answers the request with the fresh catalog. Serialized by `#modelRefreshChain`,
   * and guarded against shutdown or a replaced transport like `#reportCodeAgentCatalogs`.
   */
  async #refreshProviderModels(
    connection: DaemonConfig,
    request: DaemonRuntimeProviderModelRefreshRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const scope = {
      request_id: requestId,
      workspace_id: connection.workspaceId,
      computer_id: connection.computerId,
    };
    const startedAt = performance.now();
    logger.info("Code Agent catalog refresh started", {
      event: "code_agent_catalog:refresh_started",
      ...scope,
      outcome: "started",
    });
    const reply = async (response: {
      accepted: boolean;
      status: "refreshed" | "error";
      message?: string;
      catalogs?: CodeAgentModelCatalog[];
    }): Promise<void> => {
      await transport.sendProviderModelRefreshResult?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        ...response,
      });
    };
    try {
      const runtimes = await this.#codeAgentDiscovery.runtimes();
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
      logger.info("Code Agent catalog refresh completed", {
        event: "code_agent_catalog:refresh_completed",
        ...scope,
        catalog_count: catalogs.length,
        elapsed_ms: Math.round(performance.now() - startedAt),
        outcome: "ok",
      });
      await reply({ accepted: true, status: "refreshed", catalogs });
    } catch (error) {
      logger.warning("Code Agent catalog refresh failed", {
        event: "code_agent_catalog:refresh_failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      if (this.#stopping || this.#transport !== transport) return;
      await reply({
        accepted: false,
        status: "error",
        message: error instanceof Error ? error.message : "model refresh failed",
      }).catch(() => {});
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

  /** Logs a revoke failure without ever logging the key itself. The failure is recorded and
   * nothing else happens: the server invalidates the key at the Agent's next
   * launch, and the daemon never retries a revoke. */
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
    // Only a launch the server explicitly asked to create a new native session for gets a
    // startup turn: a daemon-initiated wake carries no `sessionMode`, and an unknown mode is
    // never treated as a cold start. Queued before the
    // launch so any message that arrives while the process is still starting queues behind it.
    const startupCompletion =
      request.sessionMode === "create" && !recoveryHasContent(recovery)
        ? this.#enqueueAgentInput(agentId, (completion) => ({ kind: "startup", completion }))
        : undefined;
    void startupCompletion?.catch(() => {});
    const launching = this.#launchAgent(agentId, config, request);
    const launch = launching
      .then(
        async (runtime) => {
          this.#ensureAgentInputDrain(agentId);
          if (recoveryCompletion) await recoveryCompletion;
          // The startup turn is not awaited: the launch (and the Start result reported from
          // it) completes when the process is up, never after a whole model turn.
          // No recovery item was enqueued for this launch at all (so
          // `#recoverAttention` never ran), yet the session is ready — flush anything
          // AgentDeliveryQueue held across an unexpected exit now.
          else {
            this.#flushSurvivingDeliveryQueue(agentId);
            this.#releaseHeldAppItems(agentId);
            this.#releaseFallbackNotices(agentId);
          }
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
        } else if (item.kind === "startup") {
          await this.#runStartupTurn(agentId);
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
        if (item.kind === "startup") {
          // The launch is not rolled back here: a provider that refuses input handles it the way
          // it handles any refused input (Kiro, for one, disposes its session), and the process
          // exit that follows is reported through the ordinary exit path.
          logger.warn("Agent startup turn was not accepted", {
            event: "agent.startup_turn.rejected",
            agent_id: agentId,
            error_code: diagnosticErrorCode(error),
          });
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
    const hasRecoveryContent = recoveryHasContent(context);
    try {
      if (hasRecoveryContent)
        await this.#messageAttention.recover(agentId, messages, context.unreadSummary ?? {});
    } catch (error) {
      logger.warn("Agent recovery notice was not accepted; canonical unread state remains", {
        event: "agent.recovery_notice.rejected",
        agent_id: agentId,
        error_code: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
    // Reconcile whatever AgentDeliveryQueue held across an unexpected exit now that
    // this launch's recovery pass has run. `recover()` above already told the Agent about the
    // same canonical unread state (the server's own unread ledger, not this in-memory queue, is
    // what a crashed-and-relaunched Agent's `resumeMessages`/`unreadSummary` are built from) —
    // drop and ACK the surviving held deliveries instead of a second, redundant notice for them.
    // When there was no recovery content, nothing else has told the Agent, so flush them now,
    // treating the freshly launched session as idle.
    if (hasRecoveryContent) this.#dropSurvivingDeliveryQueue(agentId);
    else this.#flushSurvivingDeliveryQueue(agentId);
    // App items (reminders, etc.) are a separate subsystem from canonical Message unread state
    // (`agent-app-inbox/`); `recover()` above never mentions them, so a held one is always
    // released here regardless of `hasRecoveryContent`, never dropped. A surviving fallback
    // notice (Kiro's `notice-undelivered`) is treated the same way for the same reason: this
    // in-memory queue does not know whether the text it held came from a Message delivery
    // `recover()` already covers or an App Inbox notice it never mentions, so always releasing
    // it is the only choice that never silently drops one.
    this.#releaseHeldAppItems(agentId);
    this.#releaseFallbackNotices(agentId);
  }

  /** Drops whatever `AgentDeliveryQueue` held for `agentId` across an unexpected exit,
   * ACKing each one — used when this launch's `recover()` pass already covered the same unread
   * state, so notifying about them again would be redundant. */
  #dropSurvivingDeliveryQueue(agentId: string): void {
    for (const message of this.#deliveryQueue.discardPending(agentId))
      void this.#ackHeldDelivery(message).catch(() => {});
  }

  /** Flushes whatever `AgentDeliveryQueue` held for `agentId` across an unexpected
   * exit, treating the (fresh or just-recovered) session as idle — used when nothing else has
   * told the Agent about it. */
  #flushSurvivingDeliveryQueue(agentId: string): void {
    const held = this.#deliveryQueue.idle(agentId);
    if (!held.length) return;
    void this.#messageAttention.flush(agentId, held).catch((error: unknown) => {
      logger.warn("Held Agent deliveries were not accepted at launch", {
        event: "agent.delivery_queue.flush_rejected",
        agent_id: agentId,
        held_count: held.length,
        error_code: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }

  #ackHeldDelivery(message: AgentMessageDelivery): Promise<void> {
    return (
      this.#transport.sendAgentDeliveryAck?.({
        ...message,
        method: AGENT_MESSAGE_ACK_METHOD,
        requestId: message.requestId,
      }) ?? Promise.resolve()
    );
  }

  /** Opens a freshly created session's first turn with a fixed prompt so its standing "Startup
   * sequence" instructions run immediately, rather than leaving the Agent idle until its first
   * real message. */
  async #runStartupTurn(agentId: string): Promise<void> {
    const session = this.#agentProcessManager.session(agentId);
    if (!session?.notify) {
      logger.debug("Agent startup turn skipped: the session accepts no input", {
        event: "agent.startup_turn.skipped",
        agent_id: agentId,
      });
      return;
    }
    await session.notify(AGENT_STARTUP_TURN_TEXT);
  }

  /** Tears down a launch whose recovery notice was rejected; returns the error to surface. */
  async #abandonLaunch(agentId: string, error: unknown): Promise<unknown> {
    this.#stoppingAgents.add(agentId);
    this.#closeAgentInputQueue(agentId, error);
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    if (activityLaunch) activityLaunch.stopping = true;
    this.#interruptIfBusy(agentId, activityLaunch);
    this.#clearActivityHeartbeat(agentId);
    this.#compactionTracker.dispose(agentId);
    this.#runtimeProgress.dispose(agentId);
    this.#lastContextUsage.delete(agentId);
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
    managedScope: { controlEpoch?: number; requestId: string; launchId: string } | undefined,
  ) {
    const { workspaceId } = this.#connection;
    if (this.#transport.requestAgentLaunchConfig)
      return this.#transport.requestAgentLaunchConfig({
        agentId,
        workspaceId,
        ...(managedScope ? managedScope : {}),
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
    // A daemon-initiated launch (no `control` — a wake, never a server Start) reuses
    // the last server-supplied launch identity remembered alongside this Agent's restart config,
    // instead of minting a fresh one. An Agent with no remembered identity (never brought under
    // AgentControl, or already forgotten by an explicit Stop) keeps minting, unchanged.
    const serverLaunch = control ? undefined : this.#agentProcessManager.serverLaunch(agentId);
    const reused = serverLaunch !== undefined;
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
      controlEpoch: request.control?.controlEpoch,
    };
    // A hand-over is meaningless when the reused launch's identity did not change; omit it so
    // the server never sees a spurious previousLaunchId equal to the report's own launchId.
    const previousLaunchId =
      reference.launchId !== (control?.launchId ?? serverLaunch?.launchId)
        ? reference.launchId
        : undefined;
    this.#sessionReferences.set(agentId, reference);
    const launch: ActivityLaunch = {
      launchId: control?.launchId ?? serverLaunch?.launchId ?? crypto.randomUUID(),
      clientSeq: reused ? this.#agentProcessManager.lastClientSeq(agentId) : 0,
      stopping: false,
    };
    // A managed launch's own scope; a reused wake resends the same scope it was remembered
    // under so `authorizeLaunch` can accept it; an unmanaged/legacy launch sends none.
    const managedScope = control
      ? { controlEpoch: control.controlEpoch, requestId, launchId: launch.launchId }
      : serverLaunch
        ? {
            controlEpoch: serverLaunch.controlEpoch,
            requestId: serverLaunch.requestId,
            launchId: serverLaunch.launchId,
          }
        : undefined;
    if (!control)
      logger.info("Agent self-initiated launch resolved its launch identity", {
        event: "agent_control:wake_launch",
        agent_id: agentId,
        launch_id: launch.launchId,
        request_id: managedScope?.requestId,
        epoch: managedScope?.controlEpoch,
        outcome: reused ? "reused" : "minted",
      });
    this.#currentActivityLaunches.set(agentId, launch);
    this.#clearActivityHeartbeat(agentId);
    this.#compactionTracker.dispose(agentId);
    this.#runtimeProgress.dispose(agentId);
    // This launch's delivery mode, read by AgentMessageAttentionIndex.receive via
    // #deliveryQueue.shouldHold on every delivery for this Agent from now on.
    this.#deliveryQueue.setProvider(agentId, config.provider);
    this.#lastContextUsage.delete(agentId);
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
      const launchConfig = await this.#requestLaunchConfig(agentId, managedScope);
      agentApiKey = launchConfig.agentApiKey;
      this.#assertRunning();
      this.#assertAgentNotStopping(agentId);
      this.#agentApiKeys.set(agentId, agentApiKey);
      const proxyToken = this.#agentProxy?.issue(agentId, agentApiKey);
      if (proxyToken) this.#agentProxyTokens.set(agentId, proxyToken);
      const localContext = proxyToken ?? this.#contextFor(agentId);
      const workspaceDirectory = agentWorkspaceDirectory(
        this.#connection.workspaceRoot,
        this.#connection.workspaceId,
        agentId,
      );
      stage = "runtime";
      const runtime = await this.#agentProcessManager.start(
        agentId,
        {
          ...config,
          ...(launchConfig.providerConfig ? { providerConfig: launchConfig.providerConfig } : {}),
          envVars: launchConfig.envVars,
        },
        workspaceDirectory,
        reference.sessionId,
        {
          COFORGE_DAEMON_SOCKET: "",
          COFORGE_AGENT_CONTEXT: localContext,
          COFORGE_AGENT_PROXY_URL: this.#agentProxy?.url ?? "",
          // Same server-authored identity the standing prompt's "Current Runtime Context"
          // section renders; exported so the Agent process and every tool it spawns
          // can read these facts directly instead of parsing them out of prose.
          ...agentRuntimeContextEnvironment({
            agentId,
            agentWorkspaceDirectory: workspaceDirectory,
            identity: launchConfig.identity,
          }),
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
                daemonInstanceId: this.#runtimeInstanceId,
                launchId: launch.launchId,
                // Read live off `reference` (the same object `#rebindAgent` mutates in place),
                // not the `requestId`/`control` consts this closure captured at
                // launch time: a driver-side session replacement reported after a rebind must
                // carry the NEW request/epoch, not the one this launch started under.
                startRequestId: reference.requestId,
                ...(reference.controlEpoch ? { controlEpoch: reference.controlEpoch } : {}),
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
        launchConfig.identity,
      );
      if (
        parseAssignedSkillPacks(launchConfig.assignedSkillPacks).includes("weekly-report-collect")
      )
        this.#collectSkillAgents.add(agentId);
      void memoryIndexReminder(workspaceDirectory).then((reminder) => {
        if (reminder) this.#messageAttention.setMemoryReminder(agentId, reminder);
      });
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
        // No leaked watchdog timer, and a later launch for this Agent starts clean.
        this.#compactionTracker.dispose(agentId);
        this.#runtimeProgress.dispose(agentId);
        this.#lastContextUsage.delete(agentId);
        this.#collectSkillAgents.delete(agentId);
        if (this.#currentActivityLaunches.get(agentId) !== launch) return;
        this.#messageAttention.clearAgent(agentId);
        // An unexpected exit only clears busy — whatever a queue_until_idle provider
        // was still holding stays queued for the next launch; only explicit Stop discards it
        // (see #releaseAgentRuntime).
        this.#deliveryQueue.onProcessExit(agentId);
        this.#revokeLocalLaunch(agentId, localContext, proxyToken);
        void this.#revokeAgentApiKey(agentId, agentApiKey).catch((revokeError) => {
          // Local access is already revoked; the key stays pending and is retried later.
          this.#logAgentApiKeyRevokeFailed(agentId, revokeError);
        });
        unsubscribe();
        if (launch.stopping) return;
        // A reused launch is tracked by AgentControl exactly like a managed one is —
        // its exit must flip the on-disk record back to "stopped" (via `wake()`'s mirror image,
        // `stopped()`) so a later wake or server Start sees a truthful record.
        if (control || reused)
          void runtime.session
            .readSessionIdentity?.()
            .then((identity) => this.#agentControl.stopped(agentId, launch.launchId, identity))
            .then(() => this.#agentSessions.replay(agentId))
            .catch(() => {});
        // An exit that leaves the most recent `error` event unresolved by a `completed`
        // outcome is a crash; any other unintentional exit keeps the stopped wording, because
        // the Agent's control state is stopped either way.
        const crashed = launch.crashDetail && buildRuntimeCrashedActivity(launch.crashDetail);
        this.#emitAgentActivity(
          agentId,
          launch,
          crashed
            ? this.#activity(agentId, crashed.detailKind, crashed.level, crashed.detail, {
                entries: crashed.entries,
                runtimeError: crashed.runtimeError,
              })
            : this.#stoppedActivity(agentId),
        );
        if (this.#currentActivityLaunches.get(agentId) === launch)
          this.#currentActivityLaunches.delete(agentId);
      });
      // `AgentProcessManager.start()` just replaced this Agent's whole restart config
      // entry, which would otherwise erase any previously remembered server launch identity —
      // re-apply it (managed: the scope this launch was authorized under; reused: the same
      // identity, unchanged) so a later wake or rebind can still find it. A reused launch also
      // tells `AgentControl` the process is running again under that identity.
      if (managedScope) {
        if (control)
          this.#agentProcessManager.rememberServerLaunch(agentId, {
            requestId: managedScope.requestId,
            controlEpoch: managedScope.controlEpoch ?? 0,
            launchId: managedScope.launchId,
          });
        else if (serverLaunch) {
          this.#agentProcessManager.rememberServerLaunch(agentId, serverLaunch);
          void this.#agentControl.wake(agentId, launch.launchId).catch(() => {});
        }
      }
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
          await this.#revokeAgentApiKey(agentId, agentApiKey);
        } catch (revokeError) {
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
        this.#compactionTracker.dispose(agentId);
        this.#runtimeProgress.dispose(agentId);
        this.#lastContextUsage.delete(agentId);
        this.#currentActivityLaunches.delete(agentId);
      }
      throw error;
    }
  }

  /**
   * Rebinds the agent's already-running process to a newer control scope:
   * `AgentControl.start()`'s single seam for "a Start met a process that is already running
   * under an older, terminal operation." Never spawns or stops anything, never requests a new
   * launch config/credential (the running process's Agent API key and local proxy token are
   * kept) — it only re-points every place the runtime remembers this launch's identity so a
   * later daemon->server message about this process carries the new scope, then immediately
   * re-reports the Session and `agent:status(active)` under it. Returns the running process's
   * current Session identity, exactly like `#launchAgent` returns one for a fresh launch, so
   * `AgentControl.start()` can report it in the rebind's `started` result.
   *
   * Every closure/map this mutates is mutated IN PLACE (`activityLaunch.launchId = launchId`,
   * not a new `ActivityLaunch` object) rather than replaced, so the `#launchAgent` closures that
   * already hold a reference to it — the process-exit handler's `#agentControl.stopped(agentId,
   * launch.launchId, ...)`, `#emitAgentActivity`'s `launch.launchId`/`launch.clientSeq`,
   * `#lastBusyActivity`'s `{ launch, ... }` identity comparisons — see the update for free,
   * without restructuring each one individually or losing the exit handler's `#currentActivityLaunches.get(agentId)
   * === launch` identity check (a *replacement* object there would silently turn that handler
   * into a no-op for the rebound launch).
   */
  async #rebindAgent(
    intent: AgentStartIntent,
    launchId: string,
  ): Promise<SessionIdentity | undefined> {
    const agentId = intent.agentId;
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    const reference = this.#sessionReferences.get(agentId);
    const previousLaunchId = activityLaunch?.launchId ?? reference?.launchId;
    if (activityLaunch) {
      activityLaunch.launchId = launchId;
      // The server's Activity idempotency key is (agentId, launchId, clientSeq)
      // (docs/observability/activity-delivery-and-errors.md); restarting it at the daemon's normal initial value under a NEW
      // launchId is exactly what a fresh launch already does and stays disjoint from every
      // clientSeq already sent under the previous launchId.
      activityLaunch.clientSeq = 0;
    }
    // Rebind moves this Agent to a genuinely new server launch identity — remember it
    // (a later wake must reuse THIS one, not the one being replaced) and reset the survived
    // clientSeq counter in lockstep with `activityLaunch.clientSeq` above.
    this.#agentProcessManager.rememberServerLaunch(agentId, {
      requestId: intent.requestId,
      controlEpoch: intent.controlEpoch ?? 0,
      launchId,
    });
    this.#agentProcessManager.recordClientSeq(agentId, 0);
    if (reference) {
      reference.requestId = intent.requestId;
      reference.controlEpoch = intent.controlEpoch;
      reference.launchId = launchId;
    }
    const session = this.#agentProcessManager.session(agentId);
    const identity = await session?.readSessionIdentity?.();
    // Raft sends `agent:session` on a rebind; mirrored here as a direct, fire-and-forget report
    // (like `#launchAgent`'s own closure), not through `AgentSessions.capture`/`replay` (which
    // would re-enter `state.run` for this agentId and deadlock: `AgentControl.start()` is
    // already running inside that same per-agent mutex). `previousLaunchId` carries the launch
    // being replaced so `AgentSessions.verify` on the server can accept the hand-over even if
    // it does not yet trust the new `launchId` alone.
    if (identity?.sessionId && this.#transport.reportAgentSession) {
      try {
        await this.#transport.reportAgentSession({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: this.#connection.workspaceId,
          computerId: this.#connection.computerId,
          agentId,
          provider: intent.provider,
          sessionId: identity.sessionId,
          startRequestId: intent.requestId,
          daemonInstanceId: this.#runtimeInstanceId,
          launchId,
          ...(previousLaunchId ? { previousLaunchId } : {}),
          ...(intent.controlEpoch !== undefined ? { controlEpoch: intent.controlEpoch } : {}),
        });
      } catch {
        // `reportAgentSession` already logs `agent_session:report_failed` at error level; a
        // failed immediate re-report is not fatal here — the persisted `record.report`
        // (`AgentSessions.capture`, in `AgentControl.start()`) is still replayed on the next
        // ready/reconnect pass.
      }
    }
    this.#sendAgentStatus(agentId, "active");
    return identity;
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
    // Every event but "session"/"usage"/"completed" means the runtime is mid-turn
    // (activity, a tool call, compaction, a content-free liveness ping, a reconnect, or an
    // error the runtime keeps running past). "completed" is the only idle transition, handled
    // below with the rest of the turn-end Activity.
    if (event.type !== "session" && event.type !== "usage" && event.type !== "completed")
      this.#deliveryQueue.busy(agentId);
    if (event.type === "session") {
      if (controlled)
        void this.#agentSessions.update(agentId, launch.launchId, event.identity).catch(() => {});
      return;
    }
    if (event.type === AGENT_RUNTIME_EVENT_TYPE.USAGE) {
      if (event.snapshot.provider === config.provider) this.#rememberUsage(event.snapshot);
      return;
    }
    if (event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE) {
      this.#sendContextUsage(
        agentId,
        launch,
        config.provider,
        event.usedTokens,
        event.windowTokens,
      );
      return;
    }
    if (event.type === "activity" || event.type === "tool-start") {
      // Providers report only WHAT happened (tool-start: name + raw input); the
      // daemon core alone decides what Activity that is, via the same
      // `toolActivity` allowlist every provider used to call for itself.
      const activity = event.type === "activity" ? event.activity : this.#toolStartActivity(event);
      // Resumed output or a new tool call means a still-open compaction is done; report
      // that first.
      if (
        (event.type === "tool-start" ||
          activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED ||
          activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED) &&
        this.#compactionTracker.finish(agentId) === "finished"
      )
        this.#emitAgentActivity(
          agentId,
          launch,
          this.#activity(
            agentId,
            AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
            "info",
            event.type === "tool-start"
              ? "Compaction finished (inferred from a new tool call)."
              : "Compaction finished (inferred from resumed output).",
          ),
        );
      const carriesEntries =
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING &&
        activity.entries?.some((entry) => entry.kind !== "tool_start");
      // A trajectory entry carrying a subagent scope (Claude parent_tool_use_id)
      // reports as subagent_activity regardless of its original detail kind, so
      // the display shows one unified "Subagent working…" signal.
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
      // Liveness-only filler: renews the busy lease, never stored.
      this.#emitAgentActivity(
        agentId,
        launch,
        this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.TOOL_END, "info", "Tool finished"),
      );
      return;
    }
    if (event.type === "compaction-started") {
      if (this.#compactionTracker.start(agentId) === "started")
        this.#emitAgentActivity(
          agentId,
          launch,
          this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT, "info", ""),
        );
      return;
    }
    if (event.type === "compaction-finished") {
      if (this.#compactionTracker.finish(agentId) === "finished")
        this.#emitAgentActivity(
          agentId,
          launch,
          this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED, "info", ""),
        );
      return;
    }
    if (event.type === "compaction-interrupted") {
      // Silent: only the internal state clears.
      this.#compactionTracker.interrupt(agentId);
      return;
    }
    if (event.type === "progress") {
      this.#runtimeProgress.observe(
        agentId,
        this.#lastBusyActivity.get(agentId)?.launch === launch,
        () =>
          this.#emitAgentActivity(
            agentId,
            launch,
            this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS, "info", ""),
          ),
      );
      return;
    }
    // Single conversion for every provider (agent-runtime/runtime-error-activity.ts): formatting,
    // the 512-char cap, redaction, the `Error: …` entry, and runtimeError classification all live
    // there, not in the provider. Remembered on the launch so a process exit that follows without
    // an intervening `completed` can report `runtime_crashed` instead of a plain `idle` exit.
    if (event.type === "error") {
      launch.crashDetail = event;
      // Classified once here: the Activity's fallback class/reason and this failure's retry
      // decision are the same reading of the same text.
      const classification = classifyRuntimeErrorText(event.message);
      const built = this.#noteRuntimeErrorRecovery(
        agentId,
        event,
        buildRuntimeErrorActivity(event, classification),
        classification,
      );
      this.#emitAgentActivity(
        agentId,
        launch,
        this.#activity(agentId, built.detailKind, built.level, built.detail, {
          entries: built.entries,
          runtimeError: built.runtimeError,
        }),
      );
      return;
    }
    if (event.type === "reconnecting") {
      const built = buildRuntimeReconnectingActivity(event);
      this.#emitAgentActivity(
        agentId,
        launch,
        this.#activity(agentId, built.detailKind, built.level, built.detail, {
          entries: built.entries,
        }),
      );
      return;
    }
    if (event.type === "notice-undelivered") {
      // A steer-mode provider accepted this notice but later learned it never reached
      // the model (Kiro's own steering buffer discarded it, or the steer call itself was never
      // accepted). Hold the exact text for redelivery once this Agent is next idle — no ACK
      // bookkeeping here; whatever originally accepted this text already settled its own ACK (or
      // never had one, for an App Inbox notice).
      this.#deliveryQueue.holdFallbackNotice(agentId, event.text);
      return;
    }
    if (event.type !== "completed") return;
    // Capture provider error text before clearing crashDetail for Activity wording.
    const collectorFailReason =
      event.status === "failed"
        ? (launch.crashDetail?.message ?? "Agent runtime failed.").slice(0, 2000)
        : undefined;
    // Only a genuinely successful turn clears the delivery-backoff streak and the
    // fingerprint fence; a failed or interrupted turn leaves both exactly as they were, so a
    // still-active backoff correctly keeps holding across it.
    if (event.status === "completed") this.#resetRuntimeErrorRecovery(agentId);
    // Release whatever a queue_until_idle provider held while this turn ran, as one
    // coalesced notice for the next turn — never blocking this turn-end Activity on it.
    const held = this.#deliveryQueue.idle(agentId);
    if (held.length) this.#flushHeldDeliveries(agentId, held);
    // Checked after the flush call above, not before: `flush` (via `#notify`) marks busy again
    // synchronously, in the same tick, whenever it actually has something to deliver — so a held
    // app item correctly re-holds itself (via `#notifyAppItem`'s own `shouldHold` check) for the
    // *next* turn end instead of racing the notice the flush just started sending.
    this.#releaseHeldAppItems(agentId);
    this.#releaseFallbackNotices(agentId);
    // A turn ending means a still-open compaction is done; report that before the turn's own
    // idle/failed/interrupted Activity.
    if (this.#compactionTracker.finish(agentId) === "finished")
      this.#emitAgentActivity(
        agentId,
        launch,
        this.#activity(
          agentId,
          AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
          "info",
          "Compaction finished (inferred from turn end).",
        ),
      );
    // A turn outcome (of any status) resolves any error observed mid-turn; a crash wording only
    // applies to a process exit with no such outcome in between. A failed turn that already
    // showed its own runtime_error Activity this turn (`crashDetail` set by the `error` event
    // above) keeps that as the one visible reason instead of layering this generic failure
    // notice on top of it — every provider's `error`-then-`completed(failed)` pair reports
    // exactly once.
    const alreadyExplained = event.status === "failed" && launch.crashDetail !== undefined;
    launch.crashDetail = undefined;
    if (controlled)
      void runtime.session
        .readSessionIdentity?.()
        .then(async (identity) => {
          if (identity) await this.#agentSessions.update(agentId, launch.launchId, identity);
        })
        .catch(() => {});
    if (!alreadyExplained)
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
    if (collectorFailReason && this.#collectSkillAgents.has(agentId))
      void this.#failCollectorRunningSlots(agentId, collectorFailReason).catch(() => {});
    void this.drainAppInboxNotices(agentId).catch(() => {});
  }

  /**
   * ADR 0032: a collector turn that dies before HTTPS submit (e.g. model 405) must
   * still settle Collect Run slots — Activity alone is not a completion boundary.
   */
  async #failCollectorRunningSlots(agentId: string, failureReason: string): Promise<void> {
    const agentApiKey = this.#agentApiKeys.get(agentId);
    if (!agentApiKey || !this.#transport.agentWeeklyReportCollect) return;
    await this.#transport.agentWeeklyReportCollect(
      {
        requestId: crypto.randomUUID(),
        failRunningSlots: true,
        failureReason,
      },
      agentApiKey,
    );
  }

  #rememberUsage(snapshot: UsageSnapshot): void {
    const current = this.#observedUsage.get(snapshot.provider);
    this.#observedUsage.set(snapshot.provider, {
      ...current,
      ...snapshot,
      primary: snapshot.primary ?? current?.primary,
      secondary: snapshot.secondary ?? current?.secondary,
      // Stamped at observation time, not when `scanUsage` later reuses this snapshot as its
      // fallback — a passively observed reading is never as fresh as "now".
      collectedAt: snapshot.collectedAt ?? new Date().toISOString(),
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
    this.#compactionTracker.dispose(agentId);
    this.#runtimeProgress.dispose(agentId);
    this.#lastContextUsage.delete(agentId);
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
   * Stop's outcome depends only on the local process exiting: revoking the
   * Agent API key is fire-and-forget alongside it, so a failed or slow revoke never fails or
   * delays the Stop. A failed revoke is logged and not retried.
   */
  async #releaseAgentRuntime(agentId: string, publishStopped = false): Promise<void> {
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    void this.#revokeAgentApiKey(agentId, this.#agentApiKeys.get(agentId)).catch((error) => {
      this.#logAgentApiKeyRevokeFailed(agentId, error);
    });
    await this.#agentProcessManager.stop(agentId);
    this.#messageAttention.clearAgent(agentId);
    // Explicit Stop discards anything a queue_until_idle provider was holding.
    this.#deliveryQueue.clearAgent(agentId);
    // An explicit Stop discards the runtime-error recovery streaks the same way — a
    // fresh start should not inherit a backoff/fence from a process that no longer exists.
    this.#clearRuntimeErrorBackoffTimer(agentId);
    this.#runtimeErrorDeliveryBackoff.reset(agentId);
    this.#runtimeErrorFingerprintFence.reset(agentId);
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

  /** The single place a `tool-start` event becomes an Activity: resolves the
   * provider's raw name/input through the shared `toolActivity` allowlist, then reattaches
   * subagent lineage the provider reported alongside the tool call. */
  #toolStartActivity(event: Extract<AgentRuntimeEvent, { type: "tool-start" }>) {
    const activity = toolActivity(event.name, event.input, event.occurredAt);
    const { subagent } = event;
    return {
      ...activity,
      entries: activity.entries.map((entry) => ({ ...entry, ...(subagent ? { subagent } : {}) })),
    };
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
   * `AgentSessionReport`): `launchId` is always
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

  /**
   * Decides what a mid-turn runtime error means for this Agent's queued deliveries —
   * retry after a backoff, stop retrying, or stop retrying because the same fingerprint has now
   * failed `RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD` times in a row — and returns the Activity
   * that should actually be reported (unchanged, unless the fence just tripped). The retry
   * decision is always taken from this failure's own text (`classifyRuntimeErrorText`), never
   * from a provider's own class/reason hint: an arbitrary provider-native string is not something
   * a fixed retry table can look up.
   */
  #noteRuntimeErrorRecovery(
    agentId: string,
    event: RuntimeErrorEvent,
    built: ReturnType<typeof buildRuntimeErrorActivity>,
    classification: RuntimeErrorClassification,
  ): ReturnType<typeof buildRuntimeErrorActivity> {
    if (classification.retryDecision !== RUNTIME_ERROR_RETRY_DECISION.RETRY) {
      // Not worth backing off for: retrying achieves nothing on its own (D's territory is the
      // user-facing side of that, e.g. auth). Leave the Agent in a truthful state instead of
      // holding a delivery behind a backoff that will never usefully resolve.
      this.#stopRuntimeErrorDeliveryBackoff(agentId);
      return built;
    }
    const fingerprint = built.runtimeError?.fingerprint ?? fingerprintRuntimeError(event.message);
    const fence = this.#runtimeErrorFingerprintFence.note(agentId, fingerprint);
    if (fence.fenced) {
      this.#applyRuntimeErrorFingerprintFence(agentId);
      return this.#runtimeErrorFingerprintFenceActivity(built, fence);
    }
    const backoff = this.#runtimeErrorDeliveryBackoff.recordFailure(agentId);
    // No deadline handed to the queue: it only records *that* the Agent is held, and this
    // release timer is the single owner of *when* that ends.
    this.#deliveryQueue.hold(agentId);
    this.#scheduleRuntimeErrorDeliveryBackoffRelease(agentId, backoff.delayMs);
    return built;
  }

  /** Overrides a runtime_error Activity's wording once the fingerprint fence has tripped: same
   * detailKind/level (still an ordinary runtime_error, so nothing new appears in a client that
   * does not yet know about fencing), but a distinguishable `errorReason` and a detail that names
   * the repeat and how to recover — CoForge's own words, not the last raw provider message alone. */
  #runtimeErrorFingerprintFenceActivity(
    built: ReturnType<typeof buildRuntimeErrorActivity>,
    fence: RuntimeErrorFingerprintFenceState,
  ): ReturnType<typeof buildRuntimeErrorActivity> {
    const detail = runtimeErrorFingerprintFenceDetail(fence, built.detail);
    return {
      ...built,
      detail,
      entries: [{ kind: "text", text: `Error: ${detail}` }],
      runtimeError: built.runtimeError && {
        ...built.runtimeError,
        errorReason: "runtime_error_fenced",
      },
    };
  }

  /** Cancels any pending release timer, releases (and flushes) anything currently held under an
   * explicit hold, and forgets the consecutive-retryable-failure streak. Only for a failure this
   * PR has decided is not worth retrying at all (a `terminal`-classified one) — never for a
   * tripped fingerprint fence, which must keep its hold instead (see
   * `#applyRuntimeErrorFingerprintFence`). Deliberately leaves the fingerprint fence's own streak
   * untouched — that one only ever resets on a successful turn (`#resetRuntimeErrorRecovery`) or
   * an explicit Stop, so a fenced Agent stays fenced across a merely non-retryable failure of a
   * different class. */
  #stopRuntimeErrorDeliveryBackoff(agentId: string): void {
    this.#clearRuntimeErrorBackoffTimer(agentId);
    const held = this.#deliveryQueue.release(agentId);
    if (held.length) this.#flushHeldDeliveries(agentId, held);
    this.#runtimeErrorDeliveryBackoff.reset(agentId);
  }

  /**
   * A tripped fingerprint fence stops retrying — cancels any pending release timer and
   * keeps (or starts) an indefinite explicit hold, so nothing currently held, and nothing newly
   * queued, reaches the runtime that just failed the same way three times in a row. Deliberately
   * never releases or flushes anything already held: doing so would deliver straight into the
   * same broken runtime this fence exists to stop retrying — the bug this method replaces
   * (reusing `#stopRuntimeErrorDeliveryBackoff`, which releases, here) removed protection instead
   * of adding it. Only an explicit Stop (`#releaseAgentRuntime` → `AgentDeliveryQueue.clearAgent`)
   * clears the hold; an unexpected exit and any relaunch that follows inherit it unchanged — see
   * the ADR's "Held deliveries while fenced" section for why that is safe and deliberate.
   */
  #applyRuntimeErrorFingerprintFence(agentId: string): void {
    this.#clearRuntimeErrorBackoffTimer(agentId);
    this.#deliveryQueue.hold(agentId);
  }

  /** A genuinely successful turn: forgets both streaks entirely. */
  #resetRuntimeErrorRecovery(agentId: string): void {
    this.#stopRuntimeErrorDeliveryBackoff(agentId);
    this.#runtimeErrorFingerprintFence.reset(agentId);
  }

  #clearRuntimeErrorBackoffTimer(agentId: string): void {
    const timer = this.#runtimeErrorBackoffTimers.get(agentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#runtimeErrorBackoffTimers.delete(agentId);
  }

  #scheduleRuntimeErrorDeliveryBackoffRelease(agentId: string, delayMs: number): void {
    this.#clearRuntimeErrorBackoffTimer(agentId);
    const timer = setTimeout(() => {
      this.#runtimeErrorBackoffTimers.delete(agentId);
      const held = this.#deliveryQueue.release(agentId);
      if (held.length) this.#flushHeldDeliveries(agentId, held);
    }, delayMs);
    this.#runtimeErrorBackoffTimers.set(agentId, timer);
  }

  /** Attempts delivery of everything just released from an explicit or busy-gated hold, as one
   * coalesced notice — never blocking the caller on it. Shared by ordinary turn-end draining and
   * the runtime-error delivery backoff. */
  #flushHeldDeliveries(agentId: string, held: AgentMessageDelivery[]): void {
    void this.#messageAttention.flush(agentId, held).catch((error: unknown) => {
      logger.warn("Held Agent deliveries were not accepted", {
        event: "agent.delivery_queue.flush_rejected",
        agent_id: agentId,
        held_count: held.length,
        error_code: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }

  #stoppedActivity(agentId: string): ActivityDraft {
    return this.#activity(
      agentId,
      AGENT_ACTIVITY_DETAIL_KIND.STOPPED,
      "info",
      "Agent runtime stopped",
    );
  }

  /** A running turn was cut by a requested stop/restart. */
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
    // Survives a later exit so a wake reusing this launchId can continue the counter
    // instead of colliding with the server's (agentId, launchId, clientSeq) idempotency key.
    this.#agentProcessManager.recordClientSeq(agentId, launch.clientSeq);
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

  /**
   * Fire-and-forget, never blocking or failing the turn it observed. Skipped when the
   * Agent's current native session id is not yet known (the daemon has not yet reported this
   * launch's first identity) or the reading is unchanged from the last one sent for this launch
   * — `#lastContextUsage` is forgotten on launch end/dispose alongside `#compactionTracker`, so a
   * new launch always sends its first reading. Reuses Activity's own `clientSeq` counter on the
   * launch, the same ordering fence `#emitAgentActivity` advances.
   */
  #sendContextUsage(
    agentId: string,
    launch: ActivityLaunch,
    provider: RuntimeProvider,
    usedTokens: number,
    windowTokens: number,
  ): void {
    const sessionId = this.#sessionReferences.get(agentId)?.sessionId;
    if (!sessionId) return;
    const last = this.#lastContextUsage.get(agentId);
    if (last && last.usedTokens === usedTokens && last.windowTokens === windowTokens) return;
    this.#lastContextUsage.set(agentId, { usedTokens, windowTokens });
    this.#transport.sendAgentContextUsage?.({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
      agentId,
      provider,
      launchId: launch.launchId,
      sessionId,
      usedTokens,
      windowTokens,
      observedAtMs: Date.now(),
      daemonInstanceId: this.#runtimeInstanceId,
      clientSeq: ++launch.clientSeq,
    });
    // Survives a later exit so a wake reusing this launchId can continue the counter,
    // the same reason `#emitAgentActivity` records it after every send on this shared counter.
    this.#agentProcessManager.recordClientSeq(agentId, launch.clientSeq);
  }

  #cleanupUnconfirmed(agentId: string, error: unknown): boolean {
    return (
      error instanceof AgentProcessCleanupError || this.#agentProcessManager.isStopping(agentId)
    );
  }

  #launchFailureMessage(agentId: string, stage: "credential" | "runtime", error: unknown): string {
    if (this.#cleanupUnconfirmed(agentId, error)) return CLEANUP_UNCONFIRMED;
    const base =
      stage === "credential"
        ? "Agent authorization could not be prepared."
        : "Agent runtime could not be started.";
    const detail = launchFailureTrace(error).launchCategory;
    const category = launchCategoryText(detail);
    return category ? `${base} Reason: ${category}.` : base;
  }

  /**
   * Reachable only for a genuine local Stop failure (the process did not exit); a revoke failure
   * no longer reaches this path (see `#releaseAgentRuntime`).
   */
  #stopFailureMessage(agentId: string, error: unknown): string {
    if (this.#cleanupUnconfirmed(agentId, error)) return CLEANUP_UNCONFIRMED;
    return "Agent runtime could not be stopped.";
  }

  /**
   * Revokes the key of an Agent process that is gone: it exited, its Stop was requested, or its
   * launch failed after the key was minted. One request, exactly then, and never again:
   * a key still in use by a running Agent is never revoked by the daemon, and
   * a revoke that fails is logged and left to the server, which invalidates every earlier key
   * of the Agent when it mints the next one.
   */
  async #revokeAgentApiKey(agentId: string, agentApiKey: string | undefined): Promise<void> {
    if (!agentApiKey) return;
    if (!this.#transport.revokeAgentApiKey) return;
    if (this.#agentApiKeys.get(agentId) === agentApiKey) this.#agentApiKeys.delete(agentId);
    await this.#transport.revokeAgentApiKey(agentApiKey);
  }

  async agentMessage(
    context: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
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
    // Task #70: the daemon owns the per-target draft for every request, and a transport retry
    // re-runs this whole flow with the SAME request id. Without this bookkeeping, a retry of an
    // older send to the same target rewrites the draft and, once it is finally accepted, clears the
    // draft a newer hold just stored — the Agent was told its held message is saved, and
    // `--send-draft` then answers SEND_DRAFT_NOT_FOUND. A replay of an older request therefore
    // touches nothing about the draft; the newest writer owns it until its own outcome.
    const draftBookkeeping = this.#draftBookkeepingFor(agentId, target);
    const replayed = draftBookkeeping.seenRequestIds.includes(request.requestId);
    if (!replayed) {
      draftBookkeeping.seenRequestIds.push(request.requestId);
      if (draftBookkeeping.seenRequestIds.length > DRAFT_REPLAY_MEMORY)
        draftBookkeeping.seenRequestIds.shift();
      draftBookkeeping.ownerRequestId = request.requestId;
    }
    const draft = request.sendDraft ? await inbox.draft(target) : undefined;
    if (request.sendDraft && !draft)
      throw new AgentPreflightError(`No saved draft for target: ${target}`, "SEND_DRAFT_NOT_FOUND");
    // A normal send replaces whatever draft was there; Raft reports that (and the hold count the
    // draft had reached) so the server can compute `continueAnywaySuggested`.
    const priorDraft = draft ?? (request.sendDraft ? undefined : await inbox.draft(target));
    const draftReholdCount = priorDraft?.reholdCount ?? 0;
    const content = draft?.content ?? request.content;
    if (content === undefined)
      throw new AgentPreflightError(
        "Agent message body is required",
        "AGENT_MESSAGE_BODY_REQUIRED",
      );
    // Raft: the boundary a draft already accounted for travels with the next attempt — a
    // `--send-draft` resend reuses the draft's `seenUpToSeq`, a fresh send inherits the draft it is
    // replacing, and only when neither has one does the daemon fall back to what this Agent has
    // consumed for the target (Raft's `getConsumedSeq`).
    const draftSeenUpToSeq = request.sendDraft ? draft?.seenUpToSeq : priorDraft?.seenUpToSeq;
    const modelSeenSequence = this.#messageAttention.modelSeenSequence(agentId, target);
    const seenUpToSeq = draftSeenUpToSeq ?? (modelSeenSequence > 0 ? modelSeenSequence : undefined);
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
      const present = mentionsInContent(content);
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
          // Raft-aligned: the outgoing content is saved as the local draft before refusing, so the
          // documented recovery is resending that exact draft, not retyping it. A replay of an
          // older request must not overwrite the draft the newest one owns.
          if (!replayed)
            await inbox.save(target, { content, attachmentIds, mentions, seenUpToSeq });
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
    if (!request.sendDraft && !replayed)
      await inbox.save(target, { content, attachmentIds, mentions, seenUpToSeq });
    // The daemon's own freshness decision, taken BEFORE any transport call: a send it holds must
    // never be issued, because a re-issue of the same request would re-decide it (observed: the
    // same requestId held at 00:18:30 and forwarded at 00:19:30 delivered a message the Agent had
    // been told was held, and the deliberate `--send-draft` resend then duplicated it). A hold
    // decided here is terminal; the server still gets the request when the daemon forwards, so its
    // own check remains the race guard for anything that arrived in between.
    const freshness = planAgentInboxFreshness({
      continueAnyway: Boolean(request.continueAnyway),
      modelSeenSequence,
      pendingMessageCount: this.#messageAttention.pendingMessageCount(agentId, target),
      latestSequence: this.#messageAttention.latestSequence(agentId, target),
    });
    const result =
      freshness.decision === "local_hold"
        ? locallyHeldSend(
            freshness,
            {
              requestId: request.requestId,
              draftReholdCount,
              freshnessContextMode: request.freshnessContextMode,
            },
            // Raft's held notice shows the newest unreviewed messages. The daemon now has them (its
            // attention index keeps a bounded window of unreviewed deliveries), so a locally decided
            // hold carries real previews instead of a bare count — and the shared post-processing
            // below then marks that window reviewed (`recordModelSeen`), which is what Raft's
            // `recordConsumedSeqs(data.seenUpToSeq)` does: the Agent has been shown the newest
            // context, so a resend is no longer held by it.
            this.#messageAttention
              .pendingWindow(agentId, target, HELD_CONTEXT_LIMIT)
              .map(({ delivery, receivedAt }) => ({
                id: delivery.messageId,
                sequence: delivery.sequence,
                senderKind: delivery.latestSenderKind ?? "system",
                senderHandle: delivery.latestSenderHandle ?? "",
                senderDescription: delivery.latestSenderDescription ?? "",
                target,
                body: delivery.body,
                // Deliveries carry no message timestamp (only the server knows when a message was
                // written), so a local preview shows when this daemon received it.
                createdAt: new Date(receivedAt).toISOString(),
                attachments: [],
              })),
          )
        : await this.#transport.agentMessage!(
            {
              protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
              requestId: request.requestId,
              agentId,
              workspaceId: this.#connection.workspaceId,
              operation: "send",
              target,
              content,
              continueAnyway: request.continueAnyway,
              draftReholdCount,
              draftReplacedExisting: !request.sendDraft && draftReholdCount > 0,
              sendDraft: request.sendDraft,
              seenUpToSeq,
              freshnessContextMode: request.freshnessContextMode,
              attachmentIds: attachmentIds ? [...attachmentIds] : undefined,
              mentions: mentions ? [...mentions] : undefined,
            },
            agentApiKey,
          );
    const held = result.state === "held";
    // Raft's `contextWasWithheld`: a withheld context was never presented to the Agent, so nothing
    // about it may be recorded (or kept in the draft) as reviewed.
    const contextWasWithheld =
      request.freshnessContextMode === "withheld" || result.freshnessContextMode === "withheld";
    if (held) {
      await inbox.replace(target, {
        content,
        attachmentIds,
        mentions,
        // Raft's held refresh (`setSavedDraft`, 1.0.32 bundle 753720-753728): the same content, one
        // hold later, remembering the frontier the notice presented so the resend clears the hold.
        reholdCount: draftReholdCount + 1,
        seenUpToSeq: contextWasWithheld ? seenUpToSeq : (result.seenUpToSeq ?? seenUpToSeq),
      });
      // A hold is the newest user-visible draft state for this target, so it takes ownership.
      draftBookkeeping.ownerRequestId = request.requestId;
    } else if (result.accepted) {
      // Only the request that owns the draft may consume it: an older send's accepted replay must
      // leave a newer hold's draft alone (task #70). An absent owner means the daemon restarted and
      // has no record, which keeps the pre-existing behaviour of clearing on acceptance.
      if (
        draftBookkeeping.ownerRequestId === undefined ||
        draftBookkeeping.ownerRequestId === request.requestId
      ) {
        await inbox.clear(target);
        draftBookkeeping.ownerRequestId = undefined;
      }
    }
    const targetMessages = result.messages.filter((message) => message.target === target);
    // Raft's `recordConsumedSeqs(data.seenUpToSeq)`: the notice presented this frontier, so the
    // Agent has consumed it and the same context will not hold the next attempt. The shown window's
    // newest sequence counts as well, for a hold whose response carries no frontier of its own.
    const consumedBoundary = Math.max(
      contextWasWithheld ? 0 : (result.seenUpToSeq ?? 0),
      ...targetMessages.map(({ sequence }) => sequence),
      0,
    );
    if (consumedBoundary > 0) {
      this.#messageAttention.recordModelSeen(agentId, target, consumedBoundary);
      // The held-context read inside `send`: the Agent just consumed these messages for `target`.
      this.#messageAttention.recordReadContext(agentId, target);
    }
    const recentUnread = contextWasWithheld
      ? []
      : (result.recentUnread ?? []).filter((message) => message.target === target);
    if (recentUnread.length > 0)
      this.#messageAttention.recordModelSeen(
        agentId,
        target,
        Math.max(...recentUnread.map(({ sequence }) => sequence)),
      );
    // Raft's freshness-decision activity (`recordFreshnessDecisionActivity`, bundle 843454): one
    // working status row per held send, titled `Send held by freshness check`, carrying the target,
    // the count line and the decision line(s) as its text. A held context in `withheld` mode was
    // never presented, so Raft reports no activity for it — and neither do we.
    if (held && !contextWasWithheld) {
      const heldDecision = heldFreshnessDecision(result.decision);
      if (heldDecision) {
        const producerFactId =
          result.producerFactId ??
          (await freshnessDecisionFactId({
            agentId,
            action: "send",
            decision: heldDecision,
            target,
            reason: result.reason ?? "",
            pendingMaxSeq: result.seenUpToSeq,
            modelSeenSeq: modelSeenSequence,
            heldMessageCount: result.shownMessageCount ?? result.messages.length,
            omittedMessageCount: result.omittedMessageCount,
          }));
        // Raft's `recordTrace("daemon.agent.inbox.freshness_decision", …)`: one record per decision,
        // field for field, so a locally decided hold is auditable next to a server-decided one.
        logger.info("Agent inbox freshness decision", {
          event: "agent.inbox.freshness_decision",
          ...this.#agentLogScope(agentId, request.requestId),
          producer_fact_id: producerFactId,
          action: "send",
          decision: heldDecision,
          target,
          reason: result.reason,
          pending_count: result.newMessageCount,
          pending_max_seq: result.seenUpToSeq,
          model_seen_seq: modelSeenSequence || undefined,
          held_message_count: result.shownMessageCount ?? result.messages.length,
          omitted_message_count: result.omittedMessageCount,
        });
        const activity = heldFreshnessActivity({
          action: "send",
          decision: heldDecision,
          target,
          messageCount: heldFreshnessMessageCount({
            decision: heldDecision,
            newMessageCount: result.newMessageCount,
            shownMessageCount: result.shownMessageCount,
          }),
          producerFactId,
        });
        this.#emitCurrentActivity(
          agentId,
          this.#activity(
            agentId,
            AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
            "info",
            activity.detail,
            {
              activityKind: activity.activityKind,
              entries: activity.entries,
              producerFactId: activity.producerFactId,
            },
          ),
        );
      }
    }
    logger.info("Agent sent a message", {
      event: "agent.message.sent",
      ...this.#agentLogScope(agentId, request.requestId),
      freshness_decision: result.decision ?? "forward",
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
      messages: contextWasWithheld ? [] : result.messages,
      summaries: [],
      // Raft's send contract, carried to the Agent unchanged.
      state: result.state,
      decision: result.decision,
      reason: result.reason,
      producerFactId: result.producerFactId,
      availableActions: result.availableActions,
      continueAnywaySuggested: result.continueAnywaySuggested,
      newMessageCount: result.newMessageCount,
      shownMessageCount: result.shownMessageCount,
      omittedMessageCount: result.omittedMessageCount,
      freshnessContextMode: result.freshnessContextMode,
      withheldMessageCount: contextWasWithheld
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
        content: request.content,
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
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.workspaceInfo) throw new Error("daemon connection is not connected");
    return this.#transport.workspaceInfo(request, agentApiKey);
  }

  async githubCredential(
    context: string,
    request: GitHubCredentialRequest,
    agentApiKey: string,
  ): Promise<GitHubCredentialResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.githubCredential)
      throw new Error("GitHub credential endpoint is not configured");
    return this.#transport.githubCredential(request, agentApiKey);
  }

  async githubCommitTrailers(
    context: string,
    request: GitHubCommitTrailersRequest,
    agentApiKey: string,
  ): Promise<GitHubCommitTrailersResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.githubCommitTrailers)
      throw new Error("GitHub commit trailers endpoint is not configured");
    return this.#transport.githubCommitTrailers(request, agentApiKey);
  }

  async manualGet(
    context: string,
    request: AgentManualGetRequest,
    agentApiKey: string,
  ): Promise<AgentManualGetResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.manualGet) throw new Error("Agent Manual endpoint is not configured");
    return this.#transport.manualGet(request, agentApiKey);
  }

  async manualSearch(
    context: string,
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.manualSearch) throw new Error("Agent Manual endpoint is not configured");
    return this.#transport.manualSearch(request, agentApiKey);
  }

  /**
   * `coforge version`'s local-only query: answered entirely from this already-running
   * Workspace child, never forwarded to Web/backend. `computerVersion` is the Computer executable
   * version this Daemon was launched with (`runDaemon(args, computerVersion)`, `packages/computer/
   * src/main.ts`'s `__workspace-daemon` dispatch); it bundles both the Computer and Daemon package
   * roles into one executable, so this is not a second installation.
   */
  async version(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentVersionResponse> {
    this.#authorizedAgent(context, agentApiKey);
    return {
      ok: true,
      daemonVersion: COFORGE_DAEMON_VERSION,
      ...(this.computerVersion ? { computerVersion: this.computerVersion } : {}),
      daemonPid: process.pid,
      startedAt: this.#startedAt,
    };
  }

  async userInfo(
    context: string,
    request: AgentUserInfoRequest,
    agentApiKey: string,
  ): Promise<AgentUserInfoResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.userInfo) throw new Error("Agent user info endpoint is not configured");
    return this.#transport.userInfo(request, agentApiKey);
  }

  async profileShow(
    context: string,
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.profileShow) throw new Error("Agent profile endpoint is not configured");
    return this.#transport.profileShow(request, agentApiKey);
  }

  async profileUpdate(
    context: string,
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.profileUpdate) throw new Error("Agent profile endpoint is not configured");
    return this.#transport.profileUpdate(request, agentApiKey);
  }

  /** Dispatches one task command to the cloud task route over its HTTPS path. The body is the
   * plain command — the route derives its principal from the Agent API key, so no envelope
   * travels with it. */
  async agentTask(context: string, command: TaskCommand, agentApiKey: string): Promise<TaskResult> {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!this.#transport.agentTask) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    const freshnessAction = command.operation === "claim" || command.operation === "update";
    if (freshnessAction && command.target) {
      const held = await this.#heldTaskResult(agentId, command, command.target, agentApiKey);
      if (held) return held;
    }
    return this.#transport.agentTask({ ...command }, agentApiKey);
  }

  /** Dispatches a channel lifecycle/roster command to the cloud route `agentChannel` maps it
   * to, returning the JSON response body unchanged. */
  async agentChannel(
    context: string,
    command: ChannelCommand,
    agentApiKey: string,
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
    agentApiKey: string,
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
    agentApiKey: string,
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

  /** Forwards Collect Run pack submit over Agent HTTPS (ADR 0032 return path). */
  async agentWeeklyReportCollect(
    context: string,
    command:
      | import("#src/connection/weekly-report-collect").WeeklyReportCollectCommand
      | import("#src/connection/weekly-report-collect").WeeklyReportCollectFailRunningCommand,
    agentApiKey?: string,
  ): Promise<import("#src/connection/weekly-report-collect").WeeklyReportCollectResult> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    this.#agentIdForContext(context);
    if (!this.#transport.agentWeeklyReportCollect)
      throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    return this.#transport.agentWeeklyReportCollect(command, agentApiKey);
  }

  /** Forwards personal key-point extraction write-back over Agent HTTPS. */
  async agentWeeklyReportKeyPoints(
    context: string,
    command: import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey?: string,
  ): Promise<import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsResult> {
    if (this.#stopping || !this.#started) throw new Error("daemon runtime is not running");
    this.#agentIdForContext(context);
    if (!this.#transport.agentWeeklyReportKeyPoints)
      throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    return this.#transport.agentWeeklyReportKeyPoints(command, agentApiKey);
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

  /** Per Agent+target draft bookkeeping (task #70), created on first use. */
  #draftBookkeepingFor(agentId: string, target: string): AgentDraftBookkeeping {
    let byTarget = this.#draftBookkeeping.get(agentId);
    if (!byTarget) {
      byTarget = new Map<string, AgentDraftBookkeeping>();
      this.#draftBookkeeping.set(agentId, byTarget);
    }
    let state = byTarget.get(target);
    if (!state) {
      state = { seenRequestIds: [] };
      byTarget.set(target, state);
    }
    return state;
  }

  #agentInbox(agentId: string): AgentInboxStateMachine {
    const existing = this.#agentInboxes.get(agentId);
    if (existing) return existing;
    // Raft's local draft state (`continue-state.json`): one file per Agent under the OS temp
    // directory, with `COFORGE_CLI_DRAFT_STATE_DIR` as the documented override (`SLOCK_CLI_DRAFT_
    // STATE_DIR` on Raft's side). Deliberately not the daemon's state directory: this is short-lived
    // continuation state, not daemon state, and tests point it at their own directory.
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
      // A queue_until_idle provider's session/notify has no safe busy path, same as an
      // ordinary message delivery — hold this app-item notice instead of sending it now, and
      // release it (re-attempting this same call) at the next turn end.
      if (this.#deliveryQueue.shouldHold(agentId)) {
        this.#deliveryQueue.holdAppItem(agentId, itemId);
        return false;
      }
      this.#deliveryQueue.busy(agentId);
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

  /** Re-attempts every app-item notice `AgentDeliveryQueue` held for `agentId` — each
   * one re-checks `shouldHold` itself inside `#notifyAppItem`, so one that is still busy (e.g. a
   * coalesced delivery flush that just re-armed busy) simply re-holds itself for the next
   * release rather than being lost or sent too early. */
  #releaseHeldAppItems(agentId: string): void {
    for (const itemId of this.#deliveryQueue.releaseAppItems(agentId))
      void this.#notifyAppItem(agentId, itemId).catch(() => {});
  }

  /**
   * Redelivers every fallback notice text `AgentDeliveryQueue` held for `agentId`
   * (Kiro's `notice-undelivered` event) as a bare `session.notify` call — never through
   * `AgentMessageAttentionIndex`, since the delivery or App Inbox item this text originally came
   * from already settled its own ACK (or never had one); this call must never produce a second
   * one. If the Agent has gone busy again by the time this runs (e.g. its own steer of another
   * held text just started a fresh turn), `notify` steers this one into that turn instead of
   * losing it.
   */
  #releaseFallbackNotices(agentId: string): void {
    const texts = this.#deliveryQueue.releaseFallbackNotices(agentId);
    if (!texts.length) return;
    const session = this.#agentProcessManager.session(agentId);
    if (!session?.notify) return;
    for (const text of texts)
      void session.notify(text).catch((error: unknown) => {
        logger.warn("A steered notice could not be redelivered after its turn ended", {
          event: "agent.delivery_queue.fallback_notice_rejected",
          agent_id: agentId,
          error_code: error instanceof Error ? error.name : "UnknownError",
        });
      });
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
    agentApiKey: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachment) throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachment(attachmentId, agentApiKey);
  }

  async agentAttachmentUpload(
    context: string,
    request: Request,
    agentApiKey: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUpload)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUpload(request, agentApiKey);
  }

  async agentAttachmentUploadSessionCreate(
    context: string,
    body: unknown,
    agentApiKey: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUploadSessionCreate)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUploadSessionCreate(body, agentApiKey);
  }

  async agentAttachmentUploadSessionComplete(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUploadSessionComplete)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUploadSessionComplete(uploadId, agentApiKey);
  }

  async agentAttachmentUploadSessionCancel(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#authorizedAgent(context, agentApiKey);
    if (!this.#transport.agentAttachmentUploadSessionCancel)
      throw new Error("daemon connection is not connected");
    return this.#transport.agentAttachmentUploadSessionCancel(uploadId, agentApiKey);
  }

  async agentAttachmentUploadSessionGet(
    context: string,
    uploadId: string,
    agentApiKey: string,
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
   * which every terminal kind and every stop path already runs.
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
    this.#compactionTracker.disposeAll();
    this.#runtimeProgress.disposeAll();
    this.#lastContextUsage.clear();
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
    // No retry timer may outlive this daemon instance: a launch that was mid-cooldown left a
    // "starting" record behind, which the next instance repairs and recovers (`recover()`).
    this.#agentControl.dispose();
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
    // Every Agent process is down now; each key they were using gets its one revoke request
    // here, best-effort: a failure is logged, never fails teardown, and is
    // not retried.
    await Promise.all(
      [...this.#agentApiKeys].map(([agentId, agentApiKey]) =>
        this.#revokeAgentApiKey(agentId, agentApiKey).catch((error) => {
          this.#logAgentApiKeyRevokeFailed(agentId, error);
        }),
      ),
    );
    try {
      await this.#transport.stop();
    } catch (error) {
      shutdownError ??= error;
    }
    // Recreate so a later start() never reuses a transport that went through `.stop()`.
    this.#transport = this.#transportFactory.create(this.#connection);
    if (shutdownError !== undefined) throw shutdownError;
  }
}

function safeRuntimeActivityMessage(activity: string, level: string, message: string): string {
  if (level === "error") return truncateCodePoints(message, 512);
  if (level === "warning") return scrubActivityText(message);
  if (activity === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS) return "";
  if (activity === AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND)
    return truncateCodePoints(scrubActivityText(message), 200);
  if (
    activity === AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.CHECKING_MESSAGES ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.THINKING_END
  ) {
    return scrubActivityText(message);
  }
  // The content-free run-start announcement (ActivityTrajectory#startRun) carries no
  // message; let it through empty instead of falling to the generic sentence below.
  if (
    (activity === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED ||
      activity === AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED) &&
    !message
  ) {
    return "";
  }
  return "Agent activity observed.";
}

// Delegates to agent-runtime/runtime-error-activity.ts's shared scrubber/fingerprint so
// warning-level Activity text and runtime-failure classification never drift from the single
// redaction/fingerprint implementation the new `error`/`reconnecting` event path also uses.
function scrubActivityText(message: string): string {
  return scrubRuntimeErrorText(message);
}

function runtimeFailureDiagnostic(message: string) {
  const safe = scrubActivityText(message);
  return {
    errorClass: "AgentRuntimeError",
    errorReason: "runtime_failure",
    fingerprint: fingerprintRuntimeError(safe),
  };
}

function validUsageWindow(window: UsageSnapshot["primary"], now: number): UsageSnapshot["primary"] {
  return window && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now
    ? window
    : undefined;
}

export type { CodeAgentProviderFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
