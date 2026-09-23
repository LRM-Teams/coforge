import { RPC_METHODS } from "./rpc-methods";
/** TypeScript boundary; codec/transport remains an adapter concern. */
export const COMPUTER_REGISTER_METHOD = RPC_METHODS.computerRegister;
export const COMPUTER_REGISTER_PROTOCOL_MAJOR = 1 as const;
export const WORKSPACE_LIST_METHOD = RPC_METHODS.workspaceList;
export const WORKSPACE_GET_METHOD = RPC_METHODS.workspaceGet;
export const DAEMON_RUNTIME_READY_METHOD = RPC_METHODS.daemonRuntimeReady;
export const DAEMON_CONNECTION_STATUS_METHOD = RPC_METHODS.daemonConnectionStatus;
export const DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD = RPC_METHODS.daemonCodeAgentsUpdate;
export const DAEMON_RUNTIME_USAGE_SCAN_METHOD = RPC_METHODS.daemonUsageScan;
export const DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD = RPC_METHODS.daemonUsageScanResult;
export const DAEMON_RUNTIME_MODEL_REFRESH_METHOD = RPC_METHODS.daemonModelRefresh;
export const DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD = RPC_METHODS.daemonModelRefreshResult;
export const COMPUTER_RESTART_METHOD = RPC_METHODS.computerRestart;
export const COMPUTER_RESTART_MESSAGE_TYPE = "coforge.rpc.v1.ComputerRestartIntent" as const;
export const COMPUTER_UPGRADE_METHOD = RPC_METHODS.computerUpgrade;
export const COMPUTER_UPGRADE_MESSAGE_TYPE = "coforge.rpc.v1.ComputerUpgradeIntent" as const;
export const COMPUTER_UPGRADE_RESULT_METHOD = RPC_METHODS.computerUpgradeResult;
export const COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE = "coforge.rpc.v1.ComputerUpgradeResult" as const;
export const AGENT_START_METHOD = RPC_METHODS.agentStart;
export const AGENT_START_MESSAGE_TYPE = "coforge.rpc.v1.AgentStartIntent" as const;
export const AGENT_STOP_METHOD = RPC_METHODS.agentStop;
export const AGENT_STOP_MESSAGE_TYPE = "coforge.rpc.v1.AgentStopIntent" as const;
export const AGENT_ACTIVITY_PROBE_METHOD = RPC_METHODS.agentActivityProbe;
export const AGENT_ACTIVITY_PROBE_MESSAGE_TYPE = "coforge.rpc.v1.AgentActivityProbe" as const;
export const USAGE_SCAN_MESSAGE_TYPE = "coforge.rpc.v1.DaemonRuntimeUsageScanRequest" as const;
export const USAGE_SCAN_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeUsageScanResponse" as const;
export const MODEL_REFRESH_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeProviderModelRefreshRequest" as const;
export const MODEL_REFRESH_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeProviderModelRefreshResponse" as const;
/** Server -> daemon, on the daemon control channel like the usage scan; per-Agent
 * rather than per-provider, so it decodes through the same `#route` chain in
 * `daemon-connection.ts` rather than a dedicated method the daemon calls. */
export const AGENT_CONTEXT_SCAN_METHOD = RPC_METHODS.agentContextScan;
/** Daemon -> server RPC carrying the scan's result. */
export const AGENT_CONTEXT_SCAN_RESULT_METHOD = RPC_METHODS.agentContextScanResult;
export const AGENT_CONTEXT_SCAN_MESSAGE_TYPE = "coforge.rpc.v1.AgentContextScanRequest" as const;
export const AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.AgentContextScanResponse" as const;
export type DaemonRuntimeMessageType =
  | typeof AGENT_START_MESSAGE_TYPE
  | typeof AGENT_STOP_MESSAGE_TYPE
  | typeof USAGE_SCAN_MESSAGE_TYPE
  | typeof USAGE_SCAN_RESPONSE_MESSAGE_TYPE
  | typeof MODEL_REFRESH_MESSAGE_TYPE
  | typeof MODEL_REFRESH_RESPONSE_MESSAGE_TYPE
  | typeof AGENT_CONTEXT_SCAN_MESSAGE_TYPE
  | typeof AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE;
export const AGENT_MESSAGE_METHOD = RPC_METHODS.agentMessage;
export const AGENT_MESSAGE_ACK_METHOD = RPC_METHODS.agentMessageAck;
export const AGENT_CHANNEL_MUTE_METHOD = RPC_METHODS.agentChannelMute;
export const AGENT_CHANNEL_UNMUTE_METHOD = RPC_METHODS.agentChannelUnmute;
export const AGENT_THREAD_UNFOLLOW_METHOD = RPC_METHODS.agentThreadUnfollow;
export const isChannelTarget = (target: string): boolean =>
  /^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target);
export const isChannelMessageTarget = (target: string): boolean =>
  /^#[a-z0-9][a-z0-9_-]{0,31}(?::(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/.test(
    target,
  );
/**
 * The parent of a thread target (everything before the first `:`), or `undefined` for a
 * top-level target. `#general:12345678` → `#general`; `@frank:12345678` → `@frank`; `#general` →
 * `undefined`.
 */
export const threadParentTarget = (target: string): string | undefined => {
  const index = target.indexOf(":");
  return index === -1 ? undefined : target.slice(0, index);
};
/** A reaction emoji: trimmed, one to sixteen characters, no whitespace. */
export const isValidReactionEmoji = (value: string): boolean =>
  value.trim() === value && value.length >= 1 && value.length <= 16 && !/\s/.test(value);
export const AGENT_MESSAGE_VALIDATION_MESSAGES = [
  "message anchor must be eight hexadecimal characters or a full UUID",
  "ambiguous message prefix; use the full UUID",
  "message anchor not found in this conversation",
  "thread root must be a top-level message",
  "message anchor is outside this target",
  "message not found or not visible to this Agent",
  "reaction emoji must be one to sixteen characters without whitespace",
  "mute requires a channel target",
  "unfollow requires a channel thread target",
] as const;
export type AgentMessageValidationMessage = (typeof AGENT_MESSAGE_VALIDATION_MESSAGES)[number];
export const AGENT_STATUS_METHOD = RPC_METHODS.agentStatus;
export const AGENT_ACTIVITY_METHOD = RPC_METHODS.agentActivity;
/** Stable Activity detail kinds shared by the Daemon producer and the Web consumer. */
export const AGENT_ACTIVITY_DETAIL_KIND = {
  MODEL_REQUEST_STARTED: "model_request_started",
  MODEL_RESPONSE_STARTED: "model_response_started",
  THINKING_STARTED: "thinking_started",
  FRESHNESS_HOLD: "freshness_hold",
  STARTING: "starting",
  STOPPED: "stopped",
  IDLE: "idle",
  RUNNING_COMMAND: "running_command",
  TOOL_STARTED: "tool_started",
  CHECKING_MESSAGES: "checking_messages",
  RUNTIME_RECONNECTING: "runtime_reconnecting",
  RUNTIME_ERROR: "runtime_error",
  // A stored native Session could not be resumed (missing, or rejected on replay); the
  // daemon reported it invalidated and is cold-starting without it. Working-level,
  // like `runtime_reconnecting` above: it narrates a fallback in progress, not a terminal state.
  RUNTIME_UNAVAILABLE: "runtime_unavailable",
  // Content-free provider stream/system event (no rendered text): keeps the
  // busy lease warm without adding a trajectory entry.
  RUNTIME_PROGRESS: "runtime_progress",
  // Liveness-only fillers: busy, but never stored in history or shown in the
  // popover. Renew the display lease the same way runtime_progress does.
  TOOL_END: "tool_end",
  THINKING_END: "thinking_end",
  COMPACTION_FINISHED: "compaction_finished",
  // The provider's review pass ended; same liveness-only class as
  // compaction_finished/tool_end above.
  REVIEW_FINISHED: "review_finished",
  // Visible, stored busy detail kinds.
  COMPACTING_CONTEXT: "compacting_context",
  SUBAGENT_ACTIVITY: "subagent_activity",
  MESSAGE_RECEIVED: "message_received",
  // The Agent's provider entered a review pass.
  REVIEWING_CHANGES: "reviewing_changes",
  // Compaction started and no finish was observed for a long time.
  COMPACTION_STALE: "compaction_stale",
  // A review pass started and no finish was observed for a long time.
  REVIEW_STALE: "review_stale",
  // The daemon is restarting a provider it found stalled.
  STALLED_RECOVERY: "stalled_recovery",
  // The daemon injected a system/control message into the Agent's session.
  SYSTEM_MESSAGE: "system_message",
  // Terminal detail kinds.
  RUNTIME_CRASHED: "runtime_crashed",
  RUNTIME_INTERRUPTED: "runtime_interrupted",
  // The provider has produced nothing for too long while work is pending.
  // Error-level presentation, like runtime_error/runtime_crashed above.
  RUNTIME_STALLED: "runtime_stalled",
  OTHER: "other",
} as const;
export type AgentActivityDetailKind =
  (typeof AGENT_ACTIVITY_DETAIL_KIND)[keyof typeof AGENT_ACTIVITY_DETAIL_KIND];
export const AGENT_SESSION_METHOD = RPC_METHODS.agentSession;
export type AgentSessionReport = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  sessionId: string;
  startRequestId: string;
  daemonInstanceId: string;
  launchId: string;
  previousLaunchId?: string;
  replacedSessionId?: string;
  controlEpoch?: number;
  sequence?: number;
  sessionState?: "empty" | "resumable" | "unknown";
};
export const AGENT_SESSION_INVALIDATE_METHOD = RPC_METHODS.agentSessionInvalidate;
/** `missing`: the stored native Session no longer exists. `provider_replay_rejected`: the
 * provider rejected replaying it. Mirrors `AgentSessionRecoveryCode`, minus `session_in_use`. */
export const AGENT_SESSION_INVALIDATE_REASONS = {
  MISSING: "missing",
  PROVIDER_REPLAY_REJECTED: "provider_replay_rejected",
} as const;
export type AgentSessionInvalidateReason =
  (typeof AGENT_SESSION_INVALIDATE_REASONS)[keyof typeof AGENT_SESSION_INVALIDATE_REASONS];
/**
 * Fire-and-forget daemon-to-cloud notice that a stored native Session is gone or was
 * rejected on replay; the daemon is cold-starting without it. Never delivered as Activity.
 * No control-fence fields (no `startRequestId`/`controlEpoch`, unlike `AgentSessionReport`):
 * the server's exact match is on `launchId` + `sessionId` alone.
 */
export type AgentSessionInvalidate = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  sessionId: string;
  daemonInstanceId: string;
  launchId: string;
  reason: AgentSessionInvalidateReason;
};
export const AGENT_CONTEXT_USAGE_METHOD = RPC_METHODS.agentContextUsage;
/**
 * Fire-and-forget daemon-to-cloud notice of the Agent's current context-window usage, observed
 * at the top-level Claude Code `result` record. Never delivered as Activity; a
 * provider with no such signal never emits it (Claude Code only today). This message never
 * shipped, so its fields are numbered contiguously.
 */
export type AgentContextUsage = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  launchId: string;
  sessionId: string;
  usedTokens: number;
  windowTokens: number;
  observedAtMs: number;
  daemonInstanceId: string;
  clientSeq: number;
};
export const WORKSPACE_PROTOCOL_MAJOR = COMPUTER_REGISTER_PROTOCOL_MAJOR;
export type Workspace = { id: string; slug: string; name: string };
export type WorkspaceInfoRequest = { protocolMajor: number; requestId: string };
export type WorkspaceInfoResponse = {
  protocolMajor: number;
  requestId: string;
  workspace: Workspace;
  humans: { id: string; name: string; displayName: string; role: string }[];
  agents: {
    id: string;
    name: string;
    displayName: string;
    role: string;
    status: string;
    activity: string;
    activityDetail: string;
    runtime: string;
    model: string;
    computerName: string;
    daemonVersion: string;
  }[];
  projects: {
    id: string;
    name: string;
    slug: string;
    githubFullName: string;
    githubHtmlUrl: string;
  }[];
  /**
   * The calling Agent's own authoritative identity, mirroring the launch-config response's
   * `identity.runtimeContext` (`buildAgentLaunchIdentity` in
   * `apps/web/src/routes/api/agent-api-keys.ts`, built from the same shared
   * `buildAgentRuntimeContext`). Every field is optional and omitted rather than sent empty, so an
   * older CLI decoder degrades cleanly. Never carries another Agent's runtime config. Named type
   * `WorkspaceInfoRuntimeContext` lives in `@lrm/coforge-sdk/agent` (`client.ts`) instead of here,
   * so the two subpaths never export a same-named type.
   */
  runtimeContext?: {
    agentId?: string;
    agentName?: string;
    runtime?: string;
    model?: string;
    reasoning?: string;
    workspaceId?: string;
    workspaceSlug?: string;
    workspaceName?: string;
    computerId?: string;
    computerName?: string;
    computerHostname?: string;
    computerOs?: string;
    computerVersion?: string;
    // The CLI fills this from `COFORGE_CURRENT_AGENT_WORKSPACE_PATH`; the server never sends it
    // (only the local Computer knows the Agent workspace path).
    agentWorkspacePath?: string;
  };
};
export const AGENT_WORKSPACE_INFO_METHOD = RPC_METHODS.agentWorkspaceInfo;

export type WorkspaceQueryRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceSlug?: string;
};

export const RUNTIME_PROVIDER = {
  COFORGE: "coforge",
  CODEX: "codex",
  CLAUDE_CODE: "claude-code",
  PI: "pi",
  KIRO: "kiro",
  CURSOR: "cursor",
  OPENCODE: "opencode",
  GROK: "grok",
} as const;
export type RuntimeProvider = (typeof RUNTIME_PROVIDER)[keyof typeof RUNTIME_PROVIDER];
/** Every RuntimeProvider value, for a zod `z.enum` or other exhaustive-tuple consumer. */
export const RUNTIME_PROVIDER_VALUES = Object.values(RUNTIME_PROVIDER) as [
  RuntimeProvider,
  ...RuntimeProvider[],
];
const RUNTIME_PROVIDERS: ReadonlySet<string> = new Set(RUNTIME_PROVIDER_VALUES);
/** The RuntimeProvider a persisted or user-supplied value names, or undefined. */
export function parseRuntimeProvider(value: unknown): RuntimeProvider | undefined {
  return typeof value === "string" && RUNTIME_PROVIDERS.has(value)
    ? (value as RuntimeProvider)
    : undefined;
}
/**
 * Whether the Daemon runs this provider as a spawned external CLI process (Codex, Claude Code,
 * Kiro) rather than in-process through the Pi SDK (Pi, CoForge). Governs whether usage scanning
 * reads that CLI's own local usage data, and whether a CoForge-managed model-provider API key
 * applies (only the in-process providers accept one).
 */
export const RUNTIME_PROVIDER_USES_EXTERNAL_CLI: Record<RuntimeProvider, boolean> = {
  [RUNTIME_PROVIDER.COFORGE]: false,
  [RUNTIME_PROVIDER.CODEX]: true,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: true,
  [RUNTIME_PROVIDER.PI]: false,
  [RUNTIME_PROVIDER.KIRO]: true,
  [RUNTIME_PROVIDER.CURSOR]: true,
  [RUNTIME_PROVIDER.OPENCODE]: true,
  [RUNTIME_PROVIDER.GROK]: true,
};
export type AgentRuntimeProviderConfig =
  | { kind: "default" }
  | { kind: "coforge"; providerId: string };

/**
 * Stable, machine-readable reasons a Computer upgrade did not complete, carried on the wire in
 * `ComputerUpgradeResult.errorCode` and, locally between the Coordinator and a Workspace daemon,
 * on `DaemonCommandResponse.errorCode`. One owner, same
 * discipline as `RUNTIME_PROVIDER`: every throw site names one of these values instead of a
 * caller parsing `error`'s free text.
 *
 * - `OPERATION_PENDING`: `MachineSupervisor.recordUpgrade` refused because a previous operation
 *   on this Workspace has not left a receipt yet (or the Coordinator could not tell whether its
 *   job is still alive). Covers what would otherwise be a separate "genuinely in flight" code -
 *   the Coordinator has no way to probe the external job's liveness, only whether a receipt or
 *   the pending TTL has arrived, so one code covers both until that changes.
 * - `LAUNCHES_PAUSED`: refused because this machine is mid-upgrade (`MachineSupervisor#assertMutable`).
 * - `LAUNCH_FAILED`: `recordUpgrade` accepted the request but the external upgrade job itself
 *   could not be started.
 * - `UPDATE_*`: reused verbatim from `packages/computer/src/updater.ts`'s `UpdateError.code`,
 *   surfaced when the job fails before any switch and there is no previous version to roll back
 *   to.
 * - `ROLLED_BACK` / `ROLLBACK_FAILED`: the job attempted a switch, it failed, and it either
 *   restored the previous version or could not (`upgrade-coordinator.ts`'s `switchRuntime`).
 * - `EXPIRED_WITHOUT_RECEIPT`: the job never left a receipt before the pending TTL passed
 *   (`computer-upgrade-receipts.ts`).
 */
export const UPGRADE_ERROR_CODE = {
  OPERATION_PENDING: "UPGRADE_OPERATION_PENDING",
  LAUNCHES_PAUSED: "UPGRADE_LAUNCHES_PAUSED",
  LAUNCH_FAILED: "UPGRADE_LAUNCH_FAILED",
  UPDATE_BUSY: "UPDATE_BUSY",
  UPDATE_FEED_INVALID: "UPDATE_FEED_INVALID",
  UPDATE_INTEGRITY_FAILED: "UPDATE_INTEGRITY_FAILED",
  UPDATE_NO_ROLLBACK: "UPDATE_NO_ROLLBACK",
  UPDATE_UNSUPPORTED_TARGET: "UPDATE_UNSUPPORTED_TARGET",
  ROLLED_BACK: "UPGRADE_ROLLED_BACK",
  ROLLBACK_FAILED: "UPGRADE_ROLLBACK_FAILED",
  EXPIRED_WITHOUT_RECEIPT: "UPGRADE_EXPIRED_WITHOUT_RECEIPT",
} as const;
export type UpgradeErrorCode = (typeof UPGRADE_ERROR_CODE)[keyof typeof UPGRADE_ERROR_CODE];
export const UPGRADE_ERROR_CODE_VALUES = Object.values(UPGRADE_ERROR_CODE) as [
  UpgradeErrorCode,
  ...UpgradeErrorCode[],
];
const UPGRADE_ERROR_CODES: ReadonlySet<string> = new Set(UPGRADE_ERROR_CODE_VALUES);
/** The known UpgradeErrorCode a wire/local value names, or undefined - including for a
 * well-formed but not-yet-known code, which callers must treat as "unknown", never reject. */
export function parseUpgradeErrorCode(value: unknown): UpgradeErrorCode | undefined {
  return typeof value === "string" && UPGRADE_ERROR_CODES.has(value)
    ? (value as UpgradeErrorCode)
    : undefined;
}
/** Shape every upgrade error code must satisfy, known or not: matches `diagnosticErrorCode`'s
 * existing low-cardinality-identifier convention. A decoder rejects a value that fails this, but
 * never rejects one that merely names a code this build has not learned about yet. */
export const UPGRADE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Every top-level `coforge-computer` command, as `packages/computer/src/cli.ts` registers them.
 * Shared here - the one module both `packages/computer` (which registers them) and `apps/web`
 * (which tells a Workspace member which one to run next, in `upgrade-failure.ts`) already
 * depend on - so a web copy string naming a command that does not exist, or a renamed CLI
 * command that copy never updated for, is one drift this constant lets a test catch instead of
 * the two packages silently disagreeing. `packages/computer/test/cli.test.ts` asserts the CLI's
 * actual registered command names equal this list.
 */
export const COMPUTER_CLI_COMMANDS = [
  "login",
  "setup",
  "install",
  "upgrade",
  "rollback",
  "start",
  "stop",
  "restart",
  "foreground",
  "logs",
  "status",
] as const;
export type ComputerCliCommand = (typeof COMPUTER_CLI_COMMANDS)[number];
export type RuntimeMetadata = {
  provider: RuntimeProvider;
  version: string;
  displayName: string;
};
export type CodeAgentModelMetadata = {
  id: string;
  displayName: string;
  description: string;
  modelProvider: string;
  reasoningEfforts: string[];
  defaultReasoning: string;
  recommended: boolean;
};
export type CodeAgentModelCatalog = {
  provider: RuntimeProvider;
  models: CodeAgentModelMetadata[];
};
export type ComputerRegisterRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceSlug: string;
  name: string;
  displayName: string;
  machineId: string;
  platform: string;
  osVersion: string;
  computerVersion: string;
  registrationIdempotencyKey: string;
};
export type ComputerRegisterResponse = {
  protocolMajor: number;
  requestId: string;
  computerId: string;
  workspaceId: string;
  daemonApiKey: string;
};
export type DaemonRuntimeReadyRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  workerInstanceId: string;
  daemonVersion?: string;
  computerVersion?: string;
  platform?: string;
  osVersion?: string;
  startedAt: number;
  runningAgentIds: string[];
  recoveredRestartRequestIds?: string[];
  recoveredUpgradeRequestIds?: string[];
  capabilities?: string[];
};
export type ComputerRestartIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  messageType?: typeof COMPUTER_RESTART_MESSAGE_TYPE;
};
export type ComputerUpgradeIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  target: "latest";
  expectedVersion?: string;
  messageType?: typeof COMPUTER_UPGRADE_MESSAGE_TYPE;
};
/** One Computer upgrade operation's terminal report, from the Daemon to the server. */
export type ComputerUpgradeResult = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  status: "succeeded" | "failed";
  completedAtMs: number;
  version?: string;
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. May be a well-formed code this SDK build does not know the name
   * of yet - the shape is validated, the vocabulary membership is not. */
  errorCode?: string;
  messageType?: typeof COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE;
};
export type DaemonRuntimeCodeAgentsUpdateRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};
export type DaemonRuntimeUsageScanRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  provider: RuntimeProvider;
  messageType?: DaemonRuntimeMessageType;
};
export type DaemonRuntimeUsageScanResponse = DaemonRuntimeUsageScanRequest & {
  accepted: boolean;
  status: string;
  message?: string;
  snapshotJson?: Uint8Array;
};
/** Server -> daemon, on the daemon control channel like the usage scan: re-run Code Agent
 * model-catalog discovery on demand so the browser's model selector can pick up a provider config
 * change without a daemon restart. */
export type DaemonRuntimeProviderModelRefreshRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  messageType?: DaemonRuntimeMessageType;
};
/** Daemon -> server. `catalogs` carries the freshly discovered catalog when `status` is
 * `refreshed`; `status` is one of `refreshed | refused | error`. */
export type DaemonRuntimeProviderModelRefreshResponse = DaemonRuntimeProviderModelRefreshRequest & {
  accepted: boolean;
  status: string;
  message?: string;
  catalogs?: CodeAgentModelCatalog[];
};
/** Server -> daemon, on the daemon control channel like the usage scan. Per-Agent: the
 * server fills `launchId`/`sessionId` from its own record of the Agent's current control state;
 * the daemon still resolves its own current launch/session independently before running anything
 * (see `DaemonRuntime.scanAgentContext`) rather than trusting these fields outright. */
export type AgentContextScanRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  launchId: string;
  sessionId: string;
  messageType?: DaemonRuntimeMessageType;
};
export const AGENT_CONTEXT_SCAN_STATUS = {
  AVAILABLE: "available",
  UNSUPPORTED: "unsupported",
  NO_SESSION: "no_session",
  UNPARSED: "unparsed",
  TIMEOUT: "timeout",
  ERROR: "error",
} as const;
export type AgentContextScanStatus =
  (typeof AGENT_CONTEXT_SCAN_STATUS)[keyof typeof AGENT_CONTEXT_SCAN_STATUS];
/** Daemon -> server RPC (method `agent:context_scan_result`). `reportJson` decodes to
 * `AgentContextReport`, present only when `status` is `"available"`. */
export type AgentContextScanResponse = AgentContextScanRequest & {
  accepted: boolean;
  status: AgentContextScanStatus;
  message?: string;
  reportJson?: Uint8Array;
};
/**
 * A parsed Claude Code `/context` report: what the current context window is made of,
 * by category, plus the per-item Memory files/Skills lists. Claude Code only today; a provider
 * with no equivalent signal never produces one. Categories are free text, kept exactly as the CLI
 * printed them (English, Claude Code's own labels — never translated); `"Free space"` is
 * recognized by name to draw the remainder in the UI. `approximate` marks a token count the CLI
 * itself only bounded (its `< N` form), never a value this parser guessed.
 */
export type AgentContextReport = {
  provider: RuntimeProvider;
  model?: string;
  usedTokens: number;
  windowTokens: number;
  observedAt: string;
  categories: { name: string; tokens: number; approximate?: boolean }[];
  memoryFiles?: { kind: string; path: string; tokens: number; approximate?: boolean }[];
  skills?: { name: string; source: string; tokens: number; approximate?: boolean }[];
};
export type AgentStartIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  previousLaunchId?: string;
  controlEpoch?: number;
  /** The server-minted launchId for this control operation's start step; required
   * whenever `controlEpoch` is set (every managed start). */
  launchId?: string;
  providerConfig?: AgentRuntimeProviderConfig;
  wakeMessage?: AgentRecoveryMessage;
  resumeMessages?: AgentRecoveryMessage[];
  unreadSummary?: Readonly<Record<string, number>>;
};
export type AgentStopIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider?: RuntimeProvider;
  controlEpoch?: number;
  messageType?: typeof AGENT_STOP_MESSAGE_TYPE;
};
/** Versioned server-to-daemon liveness probe; the daemon answers with an AgentActivity. */
export type AgentActivityProbe = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  probeId: string;
};
export type AgentRecoveryMessage = {
  messageId: string;
  deliveryId: string;
  conversationId: string;
  sequence: number;
  target: string;
  latestSenderKind: import("./message-sender").MessageSenderKind;
  latestSenderHandle: string;
  latestSenderDescription: string;
  body: string;
};
export type AgentMessageDelivery = {
  protocolMajor: number;
  requestId: string;
  messageId: string;
  deliveryId: string;
  sequence: number;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  body: string;
  method: typeof AGENT_MESSAGE_METHOD;
  target?: string;
  latestSenderKind?: import("./message-sender").MessageSenderKind;
  latestSenderHandle?: string;
  latestSenderDescription?: string;
  /** True when this delivery personally @mentioned the recipient Agent. */
  mentionsAgent?: boolean;
};
export type AgentMessageDeliveryAck = Omit<
  AgentMessageDelivery,
  "body" | "conversationId" | "method" | "requestId"
> & { method: typeof AGENT_MESSAGE_ACK_METHOD; requestId: string };
export { parseActivityEntries } from "./activity-entries";
export { freshnessDecisionFactId, stableNormalizeFreshnessFact } from "./freshness-decision";
export type { FreshnessDecisionAction, FreshnessDecisionFactInput } from "./freshness-decision";
export { codePointLength, truncateCodePoints } from "./truncate";
export {
  compareReleaseVersions,
  isValidReleaseVersion,
  parseReleaseVersion,
} from "./release-version";
export type { ActivityTrajectoryEntry, ActivitySubagent } from "./activity-entries";
export type AgentActivity = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  detailKind: string;
  level: "info" | "warning" | "error";
  detail: string;
  messageId?: string;
  conversationId?: string;
  observedAtMs: number;
  launchId: string;
  clientSeq: number;
  activityKind?: import("./agent-display").AgentActivityKind;
  entries?: import("./activity-entries").ActivityTrajectoryEntry[];
  /** True when this frame re-sends the last busy activity to renew the display lease. */
  isHeartbeat?: boolean;
  /** Set only on the daemon's reply to an AgentActivityProbe; echoes its probeId. */
  probeId?: string;
  /** Raft's freshness-decision lineage (`buildApmFreshnessDecisionProducerFactId`):
   * `freshness_decision_fact:<sha256>` for the decision this row narrates. A freshness-hold row
   * only; absent otherwise. */
  producerFactId?: string;
  runtimeError?: {
    errorClass: string;
    errorReason: string;
    fingerprint: string;
  };
};
export type AgentStatus = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  status: "active" | "inactive";
  daemonInstanceId: string;
  clientSeq: number;
  observedAtMs: number;
};
export type AgentMessageRequest = {
  protocolMajor: number;
  requestId: string;
  agentId: string;
  workspaceId: string;
  fromSequence?: number;
  throughSequence?: number;
  operation:
    | "check"
    | "read"
    | "search"
    | "send"
    | "mute"
    | "unmute"
    | "thread-unfollow"
    | "resolve"
    | "react"
    | "unreact";
  target: string;
  content?: string;
  continueAnyway?: boolean;
  /** `send` only: the boundary the sender has already reviewed. */
  seenUpToSeq?: number;
  /** `send` only: how many times this draft has already been held (`continueAnywaySuggested`). */
  draftReholdCount?: number;
  /** `send` only: a normal send that replaced an already-held draft. */
  draftReplacedExisting?: boolean;
  /** `send` only: this is the resend of a held draft (Raft's `sendDraft` in the v2 send body). */
  sendDraft?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  query?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  offset?: number;
  freshnessContextMode?: "inline" | "withheld";
  messageId?: string;
  emoji?: string;
  /** `send` only: attachments already uploaded to this conversation, in send order. */
  attachmentIds?: string[];
  /** `send` only: structured @mention bindings; see `LocalMentionSelector`. */
  mentions?: import("./local-daemon").LocalMentionSelector[];
};
export interface ComputerRegisterTransport {
  request(
    method: typeof COMPUTER_REGISTER_METHOD,
    payload: ComputerRegisterRequest,
  ): Promise<ComputerRegisterResponse>;
}

export class ComputerRegistrationClient {
  constructor(private readonly transport: ComputerRegisterTransport) {}
  register(request: ComputerRegisterRequest): Promise<ComputerRegisterResponse> {
    if (request.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR)
      throw new Error("unsupported computer register protocol major");
    return this.transport.request(COMPUTER_REGISTER_METHOD, request).then((response) => {
      if (response.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR)
        throw new Error("unsupported response protocol major");
      return response;
    });
  }
}

export interface WorkspaceQueryTransport {
  listAccessible(request: WorkspaceQueryRequest): Promise<Workspace[]>;
  getBySlug(request: WorkspaceQueryRequest): Promise<Workspace>;
}

export {
  DAEMON_HANDSHAKE_METHOD,
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  frameLocalRpc,
  readLocalRpcFrame,
  readLocalRpcFrames,
  DAEMON_RUNTIME_CONFIGURE_METHOD,
  LOCAL_RPC_PROTOCOL_MAJOR,
  LOCAL_RPC_METHODS,
  encodeLocalRpcRequest,
  decodeLocalRpcRequest,
  encodeLocalRpcResponse,
  decodeLocalRpcResponse,
  encodeDaemonRuntimeConfigureRequest,
  decodeDaemonRuntimeConfigureRequest,
  encodeDaemonRuntimeConfigureResponse,
  decodeDaemonRuntimeConfigureResponse,
  encodeDaemonCommandRequest,
  decodeDaemonCommandRequest,
  encodeDaemonCommandResponse,
  decodeDaemonCommandResponse,
  encodeAgentMessageResponse,
  decodeAgentMessageResponse,
  encodeLocalInboxRequest,
  decodeLocalInboxRequest,
  encodeInboxResponse,
  decodeInboxResponse,
  encodeLocalAttachment,
  encodeLocalAttachments,
  decodeLocalAttachments,
  encodeUsageScanRequest,
  decodeUsageScanRequest,
  encodeUsageScanResponse,
  decodeUsageScanResponse,
  encodeDaemonHoldRequest,
  decodeDaemonHoldRequest,
  encodeDaemonHoldResponse,
  decodeDaemonHoldResponse,
} from "./local-daemon";
export type {
  AgentMessageRecord,
  MessageTaskMetadata,
  LocalMentionSelector,
  LocalAttachment,
} from "./local-daemon";
export type {
  DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  DaemonRuntimeConfigureRequest,
  DaemonRuntimeConfigureResponse,
  LocalRpcRequest,
  LocalRpcResponse,
  DaemonCommandRequest,
  DaemonCommandResponse,
  ManagedRuntimeIdentity,
  LocalAgentMessageRequest,
  AgentMessageResponse,
  LocalInboxRequest,
  InboxResponse,
  InboxEntry,
  AppInboxItem,
  UsageScanRequest,
  UsageScanResponse,
  DaemonHoldRequest,
  DaemonHoldResponse,
  HeldBusyAgent,
} from "./local-daemon";
export {
  encodeDaemonRuntimeReadyRequest,
  decodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  decodeDaemonRuntimeCodeAgentsUpdateRequest,
  encodeDaemonRuntimeUsageScanRequest,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  decodeDaemonRuntimeUsageScanResponse,
  encodeDaemonRuntimeProviderModelRefreshRequest,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  decodeDaemonRuntimeProviderModelRefreshResponse,
  encodeAgentContextScanRequest,
  decodeAgentContextScanRequest,
  encodeAgentContextScanResponse,
  decodeAgentContextScanResponse,
  encodeComputerRestartIntent,
  decodeComputerRestartIntent,
  encodeComputerUpgradeIntent,
  decodeComputerUpgradeIntent,
  encodeComputerUpgradeResult,
  decodeComputerUpgradeResult,
  sanitizeUpgradeErrorText,
} from "./codec";
export {
  encodeAgentSessionReport,
  decodeAgentSessionReport,
  encodeAgentSessionInvalidate,
  decodeAgentSessionInvalidate,
  encodeAgentContextUsage,
  decodeAgentContextUsage,
  encodeAgentStartIntent,
  decodeAgentStartIntent,
  encodeAgentStopIntent,
  decodeAgentStopIntent,
  encodeAgentActivityProbe,
  decodeAgentActivityProbe,
  encodeAgentMessageDelivery,
  decodeAgentMessageDelivery,
  encodeAgentMessageDeliveryAck,
  decodeAgentMessageDeliveryAck,
  encodeAgentActivity,
  decodeAgentActivity,
  encodeAgentStatus,
  decodeAgentStatus,
  validateAgentMessageRequest,
} from "./codec";
export * from "./agent-skills";
export * from "./agent-workspace-files";
export * from "./agent-control";
export * from "./reminder";
export * from "./tasks";
export * from "./task-codec";
export * from "./channel-command";
export * from "./agent-display";
export * from "./message-sender";
export * from "./codec";
export * from "./validation";
export * from "./weekly-report";
export * from "./mentions";
export * from "./task-references";
export * from "./channel-references";
export * from "./readable-body";
export * from "./tool-display";
