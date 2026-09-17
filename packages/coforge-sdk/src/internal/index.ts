/** TypeScript boundary approved by ADR 0004; codec/transport remains an adapter concern. */
export const COMPUTER_REGISTER_METHOD = "computer:register" as const;
export const COMPUTER_REGISTER_PROTOCOL_MAJOR = 1 as const;
export const WORKSPACE_LIST_METHOD = "workspace:list" as const;
export const WORKSPACE_GET_METHOD = "workspace:get" as const;
export const DAEMON_RUNTIME_READY_METHOD = "daemon:runtime_ready" as const;
export const DAEMON_CONNECTION_STATUS_METHOD = "daemon:connection_status" as const;
export const DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD = "daemon:code_agents_update" as const;
export const DAEMON_RUNTIME_USAGE_SCAN_METHOD = "daemon:usage_scan" as const;
export const DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD = "daemon:usage_scan_result" as const;
export const COMPUTER_RESTART_METHOD = "computer:restart" as const;
export const COMPUTER_RESTART_MESSAGE_TYPE = "coforge.rpc.v1.ComputerRestartIntent" as const;
export const COMPUTER_UPGRADE_METHOD = "computer:upgrade" as const;
export const COMPUTER_UPGRADE_MESSAGE_TYPE = "coforge.rpc.v1.ComputerUpgradeIntent" as const;
export const COMPUTER_UPGRADE_RESULT_METHOD = "computer:upgrade_result" as const;
export const COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE = "coforge.rpc.v1.ComputerUpgradeResult" as const;
export const AGENT_START_METHOD = "agent:start" as const;
export const AGENT_START_MESSAGE_TYPE = "coforge.rpc.v1.AgentStartIntent" as const;
export const AGENT_STOP_METHOD = "agent:stop" as const;
export const AGENT_STOP_MESSAGE_TYPE = "coforge.rpc.v1.AgentStopIntent" as const;
export const AGENT_ACTIVITY_PROBE_METHOD = "agent:activity_probe" as const;
export const AGENT_ACTIVITY_PROBE_MESSAGE_TYPE = "coforge.rpc.v1.AgentActivityProbe" as const;
export const USAGE_SCAN_MESSAGE_TYPE = "coforge.rpc.v1.DaemonRuntimeUsageScanRequest" as const;
export const USAGE_SCAN_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeUsageScanResponse" as const;
export type DaemonRuntimeMessageType =
  | typeof AGENT_START_MESSAGE_TYPE
  | typeof AGENT_STOP_MESSAGE_TYPE
  | typeof USAGE_SCAN_MESSAGE_TYPE
  | typeof USAGE_SCAN_RESPONSE_MESSAGE_TYPE;
export const AGENT_MESSAGE_METHOD = "agent:deliver" as const;
export const AGENT_MESSAGE_ACK_METHOD = "agent:deliver:ack" as const;
export const AGENT_CHANNEL_MUTE_METHOD = "agent:channel:mute" as const;
export const AGENT_CHANNEL_UNMUTE_METHOD = "agent:channel:unmute" as const;
export const AGENT_THREAD_UNFOLLOW_METHOD = "agent:thread:unfollow" as const;
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
export const AGENT_STATUS_METHOD = "agent:status" as const;
export const AGENT_ACTIVITY_METHOD = "agent:activity" as const;
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
  // Content-free provider stream/system event (no rendered text): keeps the
  // busy lease warm without adding a trajectory entry.
  RUNTIME_PROGRESS: "runtime_progress",
  // Liveness-only fillers: busy, but never stored in history or shown in the
  // popover. Renew the display lease the same way runtime_progress does.
  TOOL_END: "tool_end",
  THINKING_END: "thinking_end",
  COMPACTION_FINISHED: "compaction_finished",
  // Visible, stored busy detail kinds.
  COMPACTING_CONTEXT: "compacting_context",
  SUBAGENT_ACTIVITY: "subagent_activity",
  MESSAGE_RECEIVED: "message_received",
  // Terminal detail kinds.
  RUNTIME_CRASHED: "runtime_crashed",
  RUNTIME_INTERRUPTED: "runtime_interrupted",
  // A stored native Session could not be resumed (missing, or rejected on replay); the
  // daemon reported it invalidated and is cold-starting without it.
  RUNTIME_UNAVAILABLE: "runtime_unavailable",
  OTHER: "other",
} as const;
export type AgentActivityDetailKind =
  (typeof AGENT_ACTIVITY_DETAIL_KIND)[keyof typeof AGENT_ACTIVITY_DETAIL_KIND];
export const AGENT_SESSION_METHOD = "agent:session" as const;
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
export const AGENT_SESSION_INVALIDATE_METHOD = "agent:session:invalidate" as const;
/** `missing`: the stored native Session no longer exists. `provider_replay_rejected`: the
 * provider rejected replaying it. Mirrors `AgentSessionRecoveryCode`, minus `session_in_use`. */
export type AgentSessionInvalidateReason = "missing" | "provider_replay_rejected";
/** Fire-and-forget daemon-to-cloud notice that a stored native Session is gone or was
 * rejected on replay; the daemon is cold-starting without it. Never delivered as Activity. */
export type AgentSessionInvalidate = {
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
  controlEpoch: number;
  reason: AgentSessionInvalidateReason;
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
};
export const AGENT_WORKSPACE_INFO_METHOD = "agent:workspace:info" as const;

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
};
export type AgentRuntimeProviderConfig =
  | { kind: "default" }
  | { kind: "coforge"; providerId: string };
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
  latestSender: string;
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
  latestSender?: string;
};
export type AgentMessageDeliveryAck = Omit<
  AgentMessageDelivery,
  "body" | "conversationId" | "method" | "requestId"
> & { method: typeof AGENT_MESSAGE_ACK_METHOD; requestId: string };
export { parseActivityEntries } from "./activity-entries";
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
  body?: string;
  holdToken?: string;
  continueAnyway?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  query?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  offset?: number;
  seenUpToSequence?: number;
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
  encodeLocalAgentMessageRequest,
  decodeLocalAgentMessageRequest,
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
export * from "./agent-control";
export * from "./reminder";
export * from "./tasks";
export * from "./task-codec";
export * from "./channel-command";
export * from "./agent-display";
export * from "./codec";
export * from "./validation";
export * from "./weekly-report";
export * from "./mentions";
