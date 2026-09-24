import { Centrifuge } from "centrifuge/build/protobuf";
import { AgentUpstreamRefusalError } from "./agent-upstream-refusal-error";
import {
  agentApiRoutes,
  decodeGitHubCredentialResponse,
  decodeGitHubCommitTrailersResponse,
} from "@lrm/coforge-sdk/agent";
import type {
  AgentEventsResponse,
  AgentChannelAttentionResponse,
  AgentThreadAttentionResponse,
  AgentHistoryResponse,
  AgentSearchResponse,
  AgentSendResponse,
  AgentResolveResponse,
  AgentReactionResponse,
  AgentMessage,
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
  AgentManualErrorCode,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
  AgentUserInfoErrorCode,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentProfileErrorCode,
  AgentMentionActionErrorCode,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
  AgentMentionPendingResponse,
} from "@lrm/coforge-sdk/agent";
import { AgentMessageRequestError } from "./agent-message-request-error";
import { AgentManualRequestError } from "./agent-manual-request-error";
import { AgentUserInfoRequestError } from "./agent-user-info-request-error";
import { AgentProfileRequestError } from "./agent-profile-request-error";
import { AgentMentionActionRequestError } from "./agent-mention-action-request-error";
import { AgentTransportError } from "./agent-transport-error";
import {
  decodeAgentWorkspaceResetRequest,
  encodeAgentControlResult,
  encodeAgentSessionReport,
  encodeAgentSessionInvalidate,
  encodeAgentContextUsage,
  AGENT_CONTROL_RESULT_METHOD,
  AGENT_SESSION_METHOD,
  AGENT_SESSION_INVALIDATE_METHOD,
  AGENT_CONTEXT_USAGE_METHOD,
  type AgentWorkspaceResetRequest,
  type AgentControlResult,
  type AgentSessionReport,
  type AgentSessionInvalidate,
  type AgentContextUsage,
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentActivityProbe,
  decodeAgentInboxPurge,
  decodeAgentSkillsListRequest,
  encodeAgentSkillsListResult,
  AGENT_SKILLS_LIST_RESULT_METHOD,
  type AgentSkillsListRequest,
  type AgentSkillsListResult,
  decodeAgentWorkspaceFilesListRequest,
  encodeAgentWorkspaceFilesListResult,
  AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
  type AgentWorkspaceFilesListRequest,
  type AgentWorkspaceFilesListResult,
  decodeAgentWorkspaceFileReadRequest,
  encodeAgentWorkspaceFileReadResult,
  AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
  type AgentWorkspaceFileReadRequest,
  type AgentWorkspaceFileReadResult,
  type ComputerUpgradeResult,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  decodeAgentContextScanRequest,
  encodeAgentContextScanResponse,
  AGENT_CONTEXT_SCAN_RESULT_METHOD,
  type AgentContextScanRequest,
  type AgentContextScanResponse,
  decodeAgentMessageDelivery,
  decodeComputerRestartIntent,
  decodeComputerUpgradeIntent,
  encodeComputerUpgradeResult,
  COMPUTER_UPGRADE_RESULT_METHOD,
  encodeAgentActivity,
  encodeAgentStatus,
  encodeAgentMessageDeliveryAck,
  encodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  DAEMON_RUNTIME_READY_METHOD,
  DAEMON_CONNECTION_STATUS_METHOD,
  DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_STATUS_METHOD,
  type DaemonRuntimeReadyRequest,
  type DaemonRuntimeCodeAgentsUpdateRequest,
  type DaemonRuntimeUsageScanRequest,
  type DaemonRuntimeUsageScanResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
  type AgentActivity,
  type AgentStatus,
  type AgentStartIntent,
  type AgentStopIntent,
  type AgentActivityProbe,
  type AgentInboxPurge,
  type AgentMessageDelivery,
  type AgentMessageDeliveryAck,
  type AgentMessageRequest,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  REMINDER_FIRE_METHOD,
  REMINDER_SNAPSHOT_METHOD,
  REMINDER_SYNC_MESSAGE_TYPE,
  decodeReminderFireResponse,
  decodeReminderSync,
  encodeReminderFireRequest,
  encodeReminderSnapshotRequest,
  type AgentReminderOperationRequest,
  type AgentReminderOperationResponse,
  type ReminderFireRequest,
  type ReminderFireResponse,
  type ReminderSnapshotRequest,
  type ReminderSync,
  type TaskRequest,
  type TaskResponse,
  type WeeklyReportRequest,
  type WeeklyReportResponse,
  type ChannelCommand,
  type ChannelOperation,
} from "@lrm/coforge-sdk/internal";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import type { AgentRuntimeProviderConfig } from "#src/code-agent/contract";
import type { AgentLaunchIdentity } from "#src/code-agent/agent-instructions";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";
import { AgentWeeklyReportRequestError } from "./agent-weekly-report-request-error";
import { controlPayloadShape } from "./control-payload";
import { connectionLiveness, INBOUND_STALLED_MS } from "./connection-liveness";
import { getLogger } from "@logtape/logtape";

export type AgentLaunchConfig = {
  agentApiKey: string;
  providerConfig?: AgentRuntimeProviderConfig;
  envVars?: Record<string, string>;
  assignedSkillPacks?: string[];
  /** Server-authored Agent identity for the standing prompt; see `agent-instructions.ts`. Not
   * part of the shared SDK today because the whole launch-config contract lives only here. */
  identity?: AgentLaunchIdentity;
};

const AGENT_STATUS_REFRESH_MS = 30_000;
export const COMPUTER_STATUS_REFRESH_MS = 30_000;
const RECONNECT_READY_RETRY_MS = 1_000;
const RECONNECT_READY_RETRY_MAX_MS = 60_000;
/** Consecutive ready failures after which this stops being a transient hiccup: the connection is
 * up and the Workspace is not recovered, so no Agent on this machine can be reached. Reached in
 * about half a minute of backoff. */
const READY_RETRY_ESCALATE_AFTER = 5;
/** Once escalated, how often to repeat the error rather than logging all of them — at the capped
 * delay this is roughly every ten minutes. */
const READY_RETRY_ESCALATE_EVERY = 10;
const REMEMBERED_REQUEST_IDS = 256;
const AGENT_RPC_TIMEOUT_MS = 10_000;
const logger = getLogger(["coforge", "daemon", "connection"]);

/** The server's own name for the ready step that failed, when its rejection carries one.
 *
 * Only this exact shape is accepted, and only the stage token is kept: a rejection message is
 * remote text, and the log must not become a place arbitrary server output is echoed. Anything else
 * yields nothing, leaving the error code as the only detail — the behaviour before servers said
 * which stage failed. */
function readyFailureStage(error: unknown): string | undefined {
  const message =
    error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return /^daemon ready failed at ([a-z_]{1,40})$/.exec(message)?.[1];
}

export interface DaemonConnectionTiming {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  scheduleRepeating?(callback: () => void, delayMs: number): unknown;
  cancelRepeating?(timer: unknown): void;
  /** The connection's own clock, so a test can cross the inbound-liveness window without
   * waiting for it. Production reads the wall clock. */
  now?(): number;
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
  requestUpgrade?(requestId: string, expectedVersion?: string): Promise<void>;
}

type AgentHttpInput<Request> = {
  url: string;
  agentApiKey: string;
  daemonApiKey: string;
  request: Request;
};

export interface AgentMessageHttpClient {
  requestRead?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentHistoryResponse>;
  requestSearch?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentSearchResponse>;
  requestSend?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentSendResponse>;
  requestResolve?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentResolveResponse>;
  requestReaction?(
    input: AgentHttpInput<AgentMessageRequest> & { method: "POST" | "DELETE" },
  ): Promise<AgentReactionResponse>;
  /** `check` drains the server-side pending events page; the server advances the read boundary. */
  requestEvents?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentEventsResponse>;
  requestChannelMute?(
    input: AgentHttpInput<AgentMessageRequest & { muted: boolean }>,
  ): Promise<AgentChannelAttentionResponse>;
  requestThreadUnfollow?(
    input: AgentHttpInput<AgentMessageRequest>,
  ): Promise<AgentThreadAttentionResponse>;
  requestReminder?(
    input: AgentHttpInput<AgentReminderOperationRequest>,
  ): Promise<AgentReminderOperationResponse>;
  requestWorkspaceInfo?(
    input: AgentHttpInput<WorkspaceInfoRequest>,
  ): Promise<WorkspaceInfoResponse>;
  requestGitHubCredential?(
    input: AgentHttpInput<GitHubCredentialRequest>,
  ): Promise<GitHubCredentialResponse>;
  requestGitHubCommitTrailers?(
    input: AgentHttpInput<GitHubCommitTrailersRequest>,
  ): Promise<GitHubCommitTrailersResponse>;
  requestManualGet?(input: AgentHttpInput<AgentManualGetRequest>): Promise<AgentManualGetResponse>;
  requestManualSearch?(
    input: AgentHttpInput<AgentManualSearchRequest>,
  ): Promise<AgentManualSearchResponse>;
  requestUserInfo?(input: AgentHttpInput<AgentUserInfoRequest>): Promise<AgentUserInfoResponse>;
  requestProfileShow?(
    input: AgentHttpInput<AgentProfileShowRequest>,
  ): Promise<AgentProfileShowResponse>;
  requestProfileUpdate?(
    input: AgentHttpInput<AgentProfileUpdateRequest>,
  ): Promise<AgentProfileUpdateResponse>;
  requestMentionPending?(
    input: AgentHttpInput<Record<string, never>>,
  ): Promise<AgentMentionPendingResponse>;
  requestMentionExecute?(
    input: AgentHttpInput<AgentMentionExecuteRequest>,
  ): Promise<AgentMentionExecuteResponse>;
}

/**
 * The internal shape `DaemonConnection.agentMessage` returns to `DaemonRuntime`, carrying exactly
 * what `DaemonRuntime` consumes across every Agent message operation. Each per-route HTTP response
 * type (`AgentHistoryResponse`/`AgentSearchResponse`/`AgentSendResponse`/`AgentResolveResponse`/
 * `AgentReactionResponse`/`AgentEventsResponse`/`AgentChannelAttentionResponse`/
 * `AgentThreadAttentionResponse`) is adapted into this shape by `agentMessage`; it is no longer
 * `CloudAgentMessageResponse & {...}` now that the shared envelope is gone.
 */
export type AgentMessageTransportResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  attentionCount: number;
  messageId?: string;
  messages: AgentMessage[];
  /** `send` only: Raft's send contract (state/decision/reason/counts). */
  state?: "sent" | "held";
  decision?: AgentSendResponse["decision"];
  reason?: string;
  producerFactId?: string;
  availableActions?: string[];
  continueAnywaySuggested?: boolean;
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  hasOlder?: boolean;
  hasNewer?: boolean;
  olderCursor?: string;
  newerCursor?: string;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** `send` only: Raft's `seenUpToSeq` on a held response — the frontier the notice presented and
   * that the daemon records as consumed (Raft's `recordConsumedSeqs`). */
  seenUpToSeq?: number;
  hasMore?: boolean;
  /** `send` only: pending messages a bypassed hold chose not to review; empty otherwise. */
  recentUnread?: AgentMessage[];
  /** `send` only: the mentions a sent message did not deliver, as the server reported them. */
  pendingMentionActions?: AgentSendResponse["pendingMentionActions"];
  unresolvedMentionHandles?: string[];
};

/** Adapts the read route's response into the shape `DaemonRuntime` consumes. */
function adaptAgentHistoryResponse(response: AgentHistoryResponse): AgentMessageTransportResponse {
  return {
    protocolMajor: response.protocolMajor,
    // The agent HTTP API names this key `idempotencyKey` (task #58 ④); the daemon's own transport
    // shape keeps `requestId`, so the two names meet here.
    requestId: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messages: response.messages,
    hasOlder: response.hasOlder,
    hasNewer: response.hasNewer,
    olderCursor: response.olderCursor,
    newerCursor: response.newerCursor,
  };
}

/** Adapts the dedicated search route's response into the shape `DaemonRuntime` consumes. */
function adaptAgentSearchResponse(response: AgentSearchResponse): AgentMessageTransportResponse {
  return {
    protocolMajor: response.protocolMajor,
    // The agent HTTP API names this key `idempotencyKey` (task #58 ④); the daemon's own transport
    // shape keeps `requestId`, so the two names meet here.
    requestId: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messages: response.results,
  };
}

/**
 * Adapts the send route's response into the shape `DaemonRuntime` consumes. Raft's own
 * `state`/`decision` are carried through unchanged; `messages` is the held context window.
 */
function adaptAgentSendResponse(response: AgentSendResponse): AgentMessageTransportResponse {
  return {
    protocolMajor: response.protocolMajor,
    // The agent HTTP API names this key `idempotencyKey` (task #58 ④); the daemon's own transport
    // shape keeps `requestId`, so the two names meet here.
    requestId: response.idempotencyKey,
    accepted: response.state === "sent",
    attentionCount: response.heldMessages?.length ?? 0,
    messageId: response.messageId,
    messages: response.heldMessages ?? [],
    state: response.state,
    decision: response.decision,
    reason: response.reason,
    producerFactId: response.producerFactId,
    availableActions: response.availableActions,
    continueAnywaySuggested: response.continueAnywaySuggested,
    newMessageCount: response.newMessageCount,
    shownMessageCount: response.shownMessageCount,
    omittedMessageCount: response.omittedMessageCount,
    freshnessContextMode: response.freshnessContextMode,
    withheldMessageCount: response.withheldMessageCount,
    seenUpToSeq: response.seenUpToSeq,
    recentUnread: response.recentUnread,
    pendingMentionActions: response.pendingMentionActions,
    unresolvedMentionHandles: response.unresolvedMentionHandles,
  };
}

/** Adapts the resolve route's response into the shape `DaemonRuntime` consumes. */
function adaptAgentResolveResponse(response: AgentResolveResponse): AgentMessageTransportResponse {
  return {
    protocolMajor: response.protocolMajor,
    // The agent HTTP API names this key `idempotencyKey` (task #58 ④); the daemon's own transport
    // shape keeps `requestId`, so the two names meet here.
    requestId: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messages: [response.message],
  };
}

/** Adapts the reaction routes' response into the shape `DaemonRuntime` consumes. */
function adaptAgentReactionResponse(
  response: AgentReactionResponse,
): AgentMessageTransportResponse {
  return {
    protocolMajor: response.protocolMajor,
    // The agent HTTP API names this key `idempotencyKey` (task #58 ④); the daemon's own transport
    // shape keeps `requestId`, so the two names meet here.
    requestId: response.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messageId: response.messageId,
    messages: [],
  };
}
export interface AgentTaskHttpClient {
  execute(input: AgentHttpInput<TaskRequest>): Promise<TaskResponse>;
}
export type AgentChannelRequest = ChannelCommand & {
  protocolMajor: number;
  workspaceId: string;
  agentId: string;
};
export interface AgentChannelHttpClient {
  execute(
    input: AgentHttpInput<AgentChannelRequest> & { method: "GET" | "POST" | "PATCH" | "DELETE" },
  ): Promise<Record<string, unknown>>;
}
export interface AgentActionPrepareHttpClient {
  execute(input: AgentHttpInput<AgentActionPrepareRequest>): Promise<AgentActionPrepareResponse>;
}
export interface AgentWeeklyReportHttpClient {
  request(input: AgentHttpInput<WeeklyReportRequest>): Promise<WeeklyReportResponse>;
}
export interface AgentWeeklyReportCollectHttpClient {
  execute(
    input: AgentHttpInput<
      | import("./weekly-report-collect").WeeklyReportCollectCommand
      | import("./weekly-report-collect").WeeklyReportCollectFailRunningCommand
    >,
  ): Promise<import("./weekly-report-collect").WeeklyReportCollectResult>;
}
export interface AgentWeeklyReportKeyPointsHttpClient {
  execute(
    input: AgentHttpInput<import("./weekly-report-key-points").WeeklyReportKeyPointsCommand>,
  ): Promise<import("./weekly-report-key-points").WeeklyReportKeyPointsResult>;
}

type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Provider-neutral client contract for the daemon's Workspace connection. */
export interface DaemonConnectionClient {
  workspaceInfo?(
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse>;
  githubCredential?(
    request: GitHubCredentialRequest,
    agentApiKey: string,
  ): Promise<GitHubCredentialResponse>;
  githubCommitTrailers?(
    request: GitHubCommitTrailersRequest,
    agentApiKey: string,
  ): Promise<GitHubCommitTrailersResponse>;
  manualGet?(request: AgentManualGetRequest, agentApiKey: string): Promise<AgentManualGetResponse>;
  manualSearch?(
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse>;
  userInfo?(request: AgentUserInfoRequest, agentApiKey: string): Promise<AgentUserInfoResponse>;
  profileShow?(
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse>;
  profileUpdate?(
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse>;
  mentionPending?(agentApiKey: string): Promise<AgentMentionPendingResponse>;
  mentionExecute?(
    request: AgentMentionExecuteRequest,
    agentApiKey: string,
  ): Promise<AgentMentionExecuteResponse>;
  onAgentWorkspaceReset?(callback: (request: AgentWorkspaceResetRequest) => void): () => void;
  sendAgentControlResult?(result: AgentControlResult): Promise<void>;
  start(token: string, config: DaemonConnectionConfig): Promise<void>;
  ready(createRequest: () => DaemonRuntimeReadyRequest): Promise<void>;
  updateCodeAgents?(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void>;
  onSkillsList?(callback: (request: AgentSkillsListRequest) => Promise<void>): () => void;
  sendSkillsListResult?(result: AgentSkillsListResult): Promise<void>;
  onWorkspaceFilesList?(
    callback: (request: AgentWorkspaceFilesListRequest) => Promise<void>,
  ): () => void;
  sendWorkspaceFilesListResult?(result: AgentWorkspaceFilesListResult): Promise<void>;
  onWorkspaceFileRead?(
    callback: (request: AgentWorkspaceFileReadRequest) => Promise<void>,
  ): () => void;
  sendWorkspaceFileReadResult?(result: AgentWorkspaceFileReadResult): Promise<void>;
  onUsageScan?(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void;
  sendUsageScanResult?(response: DaemonRuntimeUsageScanResponse): Promise<void>;
  onProviderModelRefresh?(
    callback: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
  ): () => void;
  sendProviderModelRefreshResult?(
    response: DaemonRuntimeProviderModelRefreshResponse,
  ): Promise<void>;
  onAgentContextScan?(callback: (request: AgentContextScanRequest) => Promise<void>): () => void;
  sendAgentContextScanResult?(response: AgentContextScanResponse): Promise<void>;
  sendUpgradeResult?(result: ComputerUpgradeResult): Promise<boolean>;
  stop(): Promise<void>;
  onReconnect?(callback: () => void): () => void;
  onAgentStart?(callback: (intent: AgentStartIntent) => void): () => void;
  onAgentStop?(callback: (intent: AgentStopIntent) => void): () => void;
  onAgentActivityProbe?(callback: (probe: AgentActivityProbe) => void): () => void;
  onAgentInboxPurge?(callback: (purge: AgentInboxPurge) => void): () => void;
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
  /** Fire-and-forget: never blocks or fails a launch. Buffered latest-per-agent while
   * disconnected and flushed on reconnect, like `sendAgentActivity`. */
  sendSessionInvalidate?(message: AgentSessionInvalidate): void;
  /** Fire-and-forget: never blocks or fails a turn. Buffered latest-per-agent while
   * disconnected and flushed on reconnect, like `sendSessionInvalidate`. */
  sendAgentContextUsage?(message: AgentContextUsage): void;
  sendAgentDeliveryAck?(ack: AgentMessageDeliveryAck): Promise<void>;
  agentMessage?(
    request: AgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageTransportResponse>;
  agentTask?(request: TaskRequest, agentApiKey: string): Promise<TaskResponse>;
  agentChannel?(
    request: AgentChannelRequest,
    agentApiKey: string,
  ): Promise<Record<string, unknown>>;
  agentActionPrepare?(
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse>;
  agentWeeklyReport?(
    request: WeeklyReportRequest,
    agentApiKey: string,
  ): Promise<WeeklyReportResponse>;
  agentWeeklyReportCollect?(
    request:
      | import("./weekly-report-collect").WeeklyReportCollectCommand
      | import("./weekly-report-collect").WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-collect").WeeklyReportCollectResult>;
  agentWeeklyReportKeyPoints?(
    request: import("./weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-key-points").WeeklyReportKeyPointsResult>;
  agentAttachment?(attachmentId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUpload?(request: Request, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCreate?(body: unknown, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionComplete?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCancel?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionGet?(uploadId: string, agentApiKey: string): Promise<Response>;
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

/** Maps a channel operation onto its cloud HTTP method and path, given the local target
 * (`create` carries no target: the channel does not exist yet). */
function channelEndpointFor(
  operation: ChannelOperation,
  target: string | undefined,
): { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string } {
  const routes = agentApiRoutes.cloud.channels;
  switch (operation) {
    case "create":
      return { method: routes.create.method, path: routes.create.path };
    case "info":
      return { method: routes.info.method, path: routes.info.path(target ?? "") };
    case "update":
      return { method: routes.update.method, path: routes.update.path(target ?? "") };
    case "members":
      return { method: routes.members.method, path: routes.members.path(target ?? "") };
    case "add-member":
      return { method: routes.addMember.method, path: routes.addMember.path(target ?? "") };
    case "remove-member":
      return { method: routes.removeMember.method, path: routes.removeMember.path(target ?? "") };
    case "join":
      return { method: routes.join.method, path: routes.join.path(target ?? "") };
    case "leave":
      return { method: routes.leave.method, path: routes.leave.path(target ?? "") };
    case "archive":
      return { method: routes.archive.method, path: routes.archive.path(target ?? "") };
    case "unarchive":
      return { method: routes.unarchive.method, path: routes.unarchive.path(target ?? "") };
  }
}

/** Authorization headers every Agent-scoped HTTP request carries. */
function agentHeaders(keys: { agentApiKey: string; daemonApiKey: string }, json = false) {
  return {
    authorization: `Bearer ${keys.daemonApiKey}`,
    "x-coforge-agent-api-key": `Bearer ${keys.agentApiKey}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

/** Invokes the HTTP fetcher, turning any thrown error into a typed pre-response transport failure. */
async function fetchAgentResponse(
  fetcher: HttpFetch,
  url: string | URL,
  init: RequestInit,
  what: string,
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (cause) {
    throw AgentTransportError.preResponseTransport(what, cause);
  }
}

/** Reads a response body as text, turning a stream failure into a typed mid-response failure. */
async function readAgentResponseText(response: Response, what: string): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw AgentTransportError.midResponseTransport(what, response.status, cause);
  }
}

/** Throws when the response is a non-2xx: a safe validation message, or a typed transport error. */
async function assertAgentResponseOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const body = await readAgentResponseText(response, what);
  // Temporary diagnostics: HTTP 5xx bodies are otherwise discarded by fromRpc, which leaves only
  // SERVER_5XX at the Agent. Log a bounded snippet so the web exception can be recovered locally.
  // Field name must not be `body` — LogTape's JSON sink redacts that key, which hid every prior probe.
  if (response.status >= 500) {
    logger.error("Upstream agent HTTP 5xx body", {
      event: "agent.http.upstream_5xx_body",
      what,
      status: response.status,
      upstream_body_length: body.length,
      upstream_body_snippet: body.length > 0 ? body.slice(0, 2000) : "<empty>",
    });
  }
  throw AgentMessageRequestError.fromRpc(response.status, body);
}

/**
 * Decodes a 2xx response body as JSON, turning a decode failure or an optional shape `validate`
 * failure into a typed protocol-mismatch error — the response arrived, but the daemon could not
 * trust it. Never lets a missing required field reach the caller as a silent `undefined`.
 */
async function readAgentResponseJson<Result>(
  response: Response,
  what: string,
  validate?: (data: unknown) => string | undefined,
): Promise<Result> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw AgentTransportError.protocolMismatch(
      what,
      response.status,
      "response body is not valid JSON",
    );
  }
  const shapeError = validate?.(data);
  if (shapeError) throw AgentTransportError.protocolMismatch(what, response.status, shapeError);
  return data as Result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** GETs `url` with the request's defined `keys` copied into the query string. */
async function getAgentJson<Result>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | number | undefined>;
    what: string;
    validate?: (data: unknown) => string | undefined;
  },
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, String(value));
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    { method: "GET", headers: agentHeaders(input) },
    input.what,
  );
  await assertAgentResponseOk(response, input.what);
  return readAgentResponseJson<Result>(response, input.what, input.validate);
}

/**
 * GETs an Agent Manual route, whose JSON error body is always `{ ok: false, errorCode, error }`
 * (Raft-aligned), unlike the plain-text/allowlisted `messages` error contract
 * `getAgentJson` assumes. A well-formed error body becomes a typed `AgentManualRequestError`
 * carrying its `errorCode` through to the CLI; anything else is a genuine transport failure.
 */
async function getAgentManualJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | undefined>;
    what: string;
  },
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, value);
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    { method: "GET", headers: agentHeaders(input) },
    input.what,
  );
  let data: unknown;
  try {
    data = await readAgentResponseText(response, input.what).then((text) => JSON.parse(text));
  } catch {
    throw AgentTransportError.protocolMismatch(
      input.what,
      response.status,
      "response body is not valid JSON",
    );
  }
  if (!response.ok) {
    const body = data as { errorCode?: unknown; error?: unknown } | null;
    if (body && typeof body.errorCode === "string" && typeof body.error === "string")
      throw new AgentManualRequestError(
        body.errorCode as AgentManualErrorCode,
        body.error,
        response.status,
      );
    throw AgentTransportError.upstreamHttpResponse(input.what, response.status);
  }
  return data as Result;
}

/**
 * Shared GET helper for a route whose JSON error body is always `{ ok: false, errorCode, error }`
 * (the same convention `getAgentManualJson` implements for the Manual routes; `user info` and
 * `profile show` reuse it here rather than duplicating the parsing). `makeError` turns a
 * well-formed error body into the route family's own typed error; anything else is a genuine
 * transport failure.
 */
async function getAgentEnvelopeJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | undefined>;
    what: string;
  },
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, value);
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    { method: "GET", headers: agentHeaders(input) },
    input.what,
  );
  return decodeAgentEnvelopeJson<Result>(response, input.what, makeError);
}

/**
 * Serializes an agent HTTP request body. Our own transport objects name the request's idempotency
 * key `requestId` (that name also crosses the local RPC to the CLI), while the agent HTTP API names
 * it `idempotencyKey` — so the wire carries the API's single name, and the two never ride together.
 */
/** Reads the `code` out of an agent API error body; a body that is absent, empty or not JSON is
 * simply a refusal without a named code, which is exactly what the caller already sees. */
async function readUpstreamErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" && body.code.length > 0 ? body.code : undefined;
  } catch {
    return undefined;
  }
}

function agentWireBody(request: unknown): string {
  if (!request || typeof request !== "object") return JSON.stringify(request);
  const { requestId, ...rest } = request as Record<string, unknown>;
  return JSON.stringify(requestId === undefined ? rest : { ...rest, idempotencyKey: requestId });
}

function mentionActionError(errorCode: string, message: string, status: number): Error {
  return new AgentMentionActionRequestError(
    errorCode as AgentMentionActionErrorCode,
    message,
    status,
  );
}

/** Same envelope convention as `getAgentEnvelopeJson`, for a POST route (`profile update`). */
async function postAgentEnvelopeJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & { body: unknown; what: string },
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  const response = await fetchAgentResponse(
    fetcher,
    input.url,
    {
      method: "POST",
      headers: agentHeaders(input, true),
      body: agentWireBody(input.body),
    },
    input.what,
  );
  return decodeAgentEnvelopeJson<Result>(response, input.what, makeError);
}

async function decodeAgentEnvelopeJson<Result extends { ok: true }>(
  response: Response,
  what: string,
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  let data: unknown;
  try {
    data = await readAgentResponseText(response, what).then((text) => JSON.parse(text));
  } catch {
    throw AgentTransportError.protocolMismatch(
      what,
      response.status,
      "response body is not valid JSON",
    );
  }
  if (!response.ok) {
    const body = data as { errorCode?: unknown; error?: unknown } | null;
    if (body && typeof body.errorCode === "string" && typeof body.error === "string")
      throw makeError(body.errorCode, body.error, response.status);
    throw AgentTransportError.upstreamHttpResponse(what, response.status);
  }
  return data as Result;
}

const AGENT_SEND_DECISIONS = new Set(["forward", "bypass", "local_hold", "syncing_hold"]);
const AGENT_SEND_STATES = new Set(["sent", "held"]);

/** Validates the send route's response shape; the incident this module exists to prevent. */
function validateAgentSendResponseShape(data: unknown): string | undefined {
  if (!isRecord(data)) return "response body is not a JSON object";
  if (typeof data.state !== "string" || !AGENT_SEND_STATES.has(data.state))
    return `response state is not one of "sent"/"held" (got ${JSON.stringify(data.state)})`;
  if (typeof data.decision !== "string" || !AGENT_SEND_DECISIONS.has(data.decision))
    return `response decision is not one of "forward"/"bypass"/"local_hold"/"syncing_hold" (got ${JSON.stringify(data.decision)})`;
  if (data.state === "held" && !Array.isArray(data.heldMessages))
    return "response is missing the heldMessages array";
  return undefined;
}

function validateAgentMessageArrayShape(field: string) {
  return (data: unknown): string | undefined =>
    isRecord(data) && Array.isArray(data[field])
      ? undefined
      : `response is missing the ${field} array`;
}

export const createAgentMessageHttpClient = (
  httpClient: HttpFetch = globalThis.fetch,
): AgentMessageHttpClient => ({
  requestRead: ({ request, ...keys }) =>
    getAgentJson(httpClient, {
      ...keys,
      what: "agent read",
      query: {
        target: request.target,
        idempotencyKey: request.requestId,
        before: request.before,
        after: request.after,
        around: request.around,
        limit: request.limit,
        fromSequence: request.fromSequence,
        throughSequence: request.throughSequence,
      },
      validate: validateAgentMessageArrayShape("messages"),
    }),
  requestSearch: ({ request, ...keys }) =>
    getAgentJson(httpClient, {
      ...keys,
      what: "agent search",
      query: {
        idempotencyKey: request.requestId,
        query: request.query,
        target: request.target,
        sender: request.sender,
        sort: request.sort,
        before: request.before,
        after: request.after,
        limit: request.limit,
        offset: request.offset,
      },
      validate: validateAgentMessageArrayShape("results"),
    }),
  async requestSend({ url, request, ...keys }) {
    const response = await fetchAgentResponse(
      httpClient,
      url,
      {
        method: "POST",
        headers: agentHeaders(keys, true),
        // Raft's `agentApiSendV2BodySchema` field names (1.0.32 bundle 16728-16744): the idempotency
        // key is `idempotencyKey` (our request id travels as it), `sendDraft` is declared when this
        // send is the resend of a held draft, and `mentions` is the structured list. Raft also
        // declares `continue`, which its own CLI never sets and whose semantics are unverified — we
        // neither send nor interpret it (the force-send flag is `continueAnyway`, as in Raft).
        body: JSON.stringify({
          idempotencyKey: request.requestId,
          target: request.target,
          content: request.content,
          continueAnyway: request.continueAnyway,
          sendDraft: request.sendDraft,
          draftReholdCount: request.draftReholdCount,
          draftReplacedExisting: request.draftReplacedExisting,
          seenUpToSeq: request.seenUpToSeq,
          freshnessContextMode: request.freshnessContextMode,
          attachmentIds: request.attachmentIds,
          mentions: request.mentions,
        }),
      },
      "agent send",
    );
    await assertAgentResponseOk(response, "agent send");
    return readAgentResponseJson<AgentSendResponse>(
      response,
      "agent send",
      validateAgentSendResponseShape,
    );
  },
  requestEvents: ({ request, ...keys }) =>
    getAgentJson<AgentEventsResponse>(httpClient, {
      ...keys,
      what: "agent events",
      query: {
        idempotencyKey: request.requestId,
        limit: request.limit,
        ...(request.target ? { target: request.target } : {}),
      },
      validate: validateAgentMessageArrayShape("events"),
    }),
  async requestChannelMute({ url, request, ...keys }) {
    const response = await fetchAgentResponse(
      httpClient,
      url,
      {
        method: "POST",
        headers: agentHeaders(keys, true),
        body: JSON.stringify({ idempotencyKey: request.requestId }),
      },
      "agent channel attention",
    );
    await assertAgentResponseOk(response, "agent channel attention");
    return readAgentResponseJson<AgentChannelAttentionResponse>(
      response,
      "agent channel attention",
    );
  },
  async requestThreadUnfollow({ url, request, ...keys }) {
    const response = await fetchAgentResponse(
      httpClient,
      url,
      {
        method: "POST",
        headers: agentHeaders(keys, true),
        body: JSON.stringify({ idempotencyKey: request.requestId }),
      },
      "agent thread attention",
    );
    await assertAgentResponseOk(response, "agent thread attention");
    return readAgentResponseJson<AgentThreadAttentionResponse>(response, "agent thread attention");
  },
  async requestResolve({ url, request, ...keys }) {
    const endpoint = new URL(url);
    endpoint.searchParams.set("idempotencyKey", request.requestId);
    const response = await fetchAgentResponse(
      httpClient,
      endpoint,
      { method: "GET", headers: agentHeaders(keys) },
      "agent resolve",
    );
    await assertAgentResponseOk(response, "agent resolve");
    return readAgentResponseJson<AgentResolveResponse>(response, "agent resolve", (data) =>
      isRecord(data) && isRecord(data.message)
        ? undefined
        : "response is missing the message object",
    );
  },
  async requestReaction({ url, request, method, ...keys }) {
    const response = await fetchAgentResponse(
      httpClient,
      url,
      {
        method,
        headers: agentHeaders(keys, true),
        body: JSON.stringify({ idempotencyKey: request.requestId, emoji: request.emoji }),
      },
      "agent reaction",
    );
    await assertAgentResponseOk(response, "agent reaction");
    return readAgentResponseJson<AgentReactionResponse>(response, "agent reaction");
  },
  async requestWorkspaceInfo({ request, ...keys }) {
    const data = await getAgentJson<
      Omit<WorkspaceInfoResponse, "protocolMajor" | "idempotencyKey">
    >(httpClient, { ...keys, what: "workspace_info", query: {} });
    return {
      ...data,
      protocolMajor: request.protocolMajor,
      requestId: request.requestId,
    };
  },
  requestManualGet: ({ request, ...keys }) =>
    getAgentManualJson<AgentManualGetResponse>(httpClient, {
      ...keys,
      what: "agent manual get",
      query: { topic: request.topic, intent: request.intent, reason: request.reason },
    }),
  requestManualSearch: ({ request, ...keys }) =>
    getAgentManualJson<AgentManualSearchResponse>(httpClient, {
      ...keys,
      what: "agent manual search",
      query: { query: request.query, intent: request.intent, reason: request.reason },
    }),
  requestUserInfo: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentUserInfoResponse>(
      httpClient,
      { ...keys, what: "agent user info", query: {} },
      (errorCode, message, status) =>
        new AgentUserInfoRequestError(errorCode as AgentUserInfoErrorCode, message, status),
    ),
  requestProfileShow: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentProfileShowResponse>(
      httpClient,
      { ...keys, what: "agent profile show", query: { target: request.target } },
      (errorCode, message, status) =>
        new AgentProfileRequestError(errorCode as AgentProfileErrorCode, message, status),
    ),
  requestProfileUpdate: ({ request, ...keys }) =>
    postAgentEnvelopeJson<AgentProfileUpdateResponse>(
      httpClient,
      { ...keys, what: "agent profile update", body: request },
      (errorCode, message, status) =>
        new AgentProfileRequestError(errorCode as AgentProfileErrorCode, message, status),
    ),
  requestMentionPending: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentMentionPendingResponse>(
      httpClient,
      { ...keys, what: "agent mention pending", query: {} },
      mentionActionError,
    ),
  requestMentionExecute: ({ request, ...keys }) =>
    postAgentEnvelopeJson<AgentMentionExecuteResponse>(
      httpClient,
      { ...keys, what: "agent mention action", body: request },
      mentionActionError,
    ),
  async requestGitHubCredential({ url, request, ...keys }) {
    const response = await httpClient(url, {
      method: "POST",
      headers: agentHeaders(keys, true),
      body: agentWireBody(request),
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub credential request failed (${response.status})`);
    return decodeGitHubCredentialResponse(await response.json());
  },
  async requestGitHubCommitTrailers({ url, request, ...keys }) {
    const response = await httpClient(url, {
      method: "POST",
      headers: agentHeaders(keys, true),
      body: agentWireBody(request),
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub commit trailers request failed (${response.status})`);
    return decodeGitHubCommitTrailersResponse(await response.json());
  },
  async requestReminder({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await httpClient(url, {
        method: "POST",
        headers: agentHeaders(keys, true),
        body: agentWireBody(request),
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Agent reminder request failed");
    }
    if (!response.ok) {
      // The server names *why* it refused in the body's `code`, exactly as the Task route does; it
      // must not ride in the caller-facing message, but it is the only record of the cause, so it is
      // attached for the daemon's own log (see `classifyAgentProxyFailure`).
      const upstreamCode = await readUpstreamErrorCode(response);
      throw new AgentUpstreamRefusalError(
        `Agent reminder request failed (${response.status})`,
        upstreamCode,
        response.status,
      );
    }
    let envelope: AgentReminderOperationResponse;
    try {
      envelope = (await response.json()) as AgentReminderOperationResponse;
    } catch {
      throw new Error("Agent reminder response is malformed");
    }
    // The agent HTTP API names the echoed key `idempotencyKey`; this transport shape keeps
    // `requestId`, so the wire value is mapped onto it here.
    const wire = envelope as unknown as { idempotencyKey?: unknown };
    if (!wire || typeof wire.idempotencyKey !== "string")
      throw new Error("Agent reminder response is malformed");
    return { ...envelope, requestId: wire.idempotencyKey };
  },
});

export const defaultAgentMessageHttpClient = createAgentMessageHttpClient();

export const defaultAgentWeeklyReportHttpClient: AgentWeeklyReportHttpClient = {
  async request({ url, request, ...keys }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: agentWireBody(request),
    });
    if (!response.ok) {
      const message = await response.text();
      if (response.status === 400 || response.status === 403)
        throw new AgentWeeklyReportRequestError(
          message.trim() ||
            (response.status === 403
              ? "Weekly report access denied"
              : "invalid weekly-report request"),
        );
      throw new Error(`server Agent weekly-report request failed (${response.status})`);
    }
    const result = (await response.json()) as WeeklyReportResponse;
    if ((result as { idempotencyKey?: string }).idempotencyKey !== request.requestId)
      throw new Error("weekly-report response request ID does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportCollectHttpClient: AgentWeeklyReportCollectHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: agentWireBody(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-collect", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse(
        "Agent weekly-report-collect",
        response.status,
      );
    const result =
      (await response.json()) as import("./weekly-report-collect").WeeklyReportCollectResult;
    if ((result as { idempotencyKey?: string }).idempotencyKey !== request.requestId)
      throw new Error("weekly-report-collect response request ID does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportKeyPointsHttpClient: AgentWeeklyReportKeyPointsHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: agentWireBody(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-key-points", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse(
        "Agent weekly-report-key-points",
        response.status,
      );
    const result =
      (await response.json()) as import("./weekly-report-key-points").WeeklyReportKeyPointsResult;
    if ((result as { idempotencyKey?: string }).idempotencyKey !== request.requestId)
      throw new Error("weekly-report-key-points response request ID does not match request");
    return result;
  },
};

export const defaultAgentTaskHttpClient: AgentTaskHttpClient = {
  async execute({ url, request, ...keys }) {
    // `TaskRequest` already names the key `idempotencyKey` (the one HTTP name), so the body goes up
    // as-is; the response echoes it for correlation.
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      // The upstream body names *why* the server refused (`{"error":…,"code":…}`). It must not ride
      // in the caller-facing message — an upstream's internals are not this API's to publish, and a
      // test pins that — but it is the only record of the cause that exists anywhere, so it is
      // attached for the daemon's own log (see `classifyAgentProxyFailure`).
      const upstreamCode = await readUpstreamErrorCode(response);
      throw new AgentUpstreamRefusalError(
        `server Agent Task request failed (${response.status})`,
        upstreamCode,
        response.status,
      );
    }
    const result = (await response.json()) as TaskResponse;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("Task response idempotency key does not match request");
    return result;
  },
};

/** Forwards the classified channel request to its mapped cloud route and returns the JSON
 * response body unchanged. A non-2xx throws a typed `AgentTransportError` carrying the real
 * upstream status (so, e.g., a 404 "channel not found" reaches the CLI as a 404, not a generic
 * 502); a network failure is the same pre-response transport failure every other Agent HTTP
 * client here reports. */
export const defaultAgentChannelHttpClient: AgentChannelHttpClient = {
  async execute({ url, method, request, ...keys }) {
    let response: Response;
    try {
      if (method === "GET") {
        const endpoint = new URL(url);
        endpoint.searchParams.set("idempotencyKey", request.requestId);
        response = await fetch(endpoint, {
          method: "GET",
          headers: agentHeaders(keys),
          signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        });
      } else {
        response = await fetch(url, {
          method: method as "POST" | "PATCH" | "DELETE",
          signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
          headers: agentHeaders(keys, true),
          body: agentWireBody(request),
        });
      }
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent Channel", cause);
    }
    // A typed error (not a bare Error) so the real upstream status (e.g. 404 "channel not
    // found") survives classification instead of collapsing into a generic 502; the CLI
    // (local-client.ts#callChannel) turns a preserved 404 into CliError code NOT_FOUND.
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse("Agent Channel", response.status);
    return (await response.json()) as Record<string, unknown>;
  },
};

export const defaultAgentActionPrepareHttpClient: AgentActionPrepareHttpClient = {
  async execute({ url, request, ...keys }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: agentWireBody(request),
    });
    if (!response.ok)
      throw new Error(`server Agent action-prepare request failed (${response.status})`);
    const result = (await response.json()) as AgentActionPrepareResponse;
    if (!result || typeof result.messageId !== "string" || result.metadata?.kind !== "action-card")
      throw new Error("action-prepare response is malformed");
    return result;
  },
};

/** One replaceable listener; unsubscribing only clears the listener it registered. */
class ListenerSlot<Listener extends (value: never) => unknown> {
  #listener: Listener | undefined;

  set(listener: Listener): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  get current(): Listener | undefined {
    return this.#listener;
  }

  clear(): void {
    this.#listener = undefined;
  }
}

/** The Daemon's single connection for its configured Workspace. */
export class DaemonConnection implements DaemonConnectionClient {
  #client: CentrifugeWorkspaceClient | undefined;
  #connected = false;
  #hasConnected = false;
  #token = "";
  #serverHttpUrl = "";
  readonly #agentStart = new ListenerSlot<(intent: AgentStartIntent) => void>();
  readonly #agentStop = new ListenerSlot<(intent: AgentStopIntent) => void>();
  readonly #agentActivityProbe = new ListenerSlot<(probe: AgentActivityProbe) => void>();
  readonly #agentInboxPurge = new ListenerSlot<(purge: AgentInboxPurge) => void>();
  readonly #agentWorkspaceReset = new ListenerSlot<(request: AgentWorkspaceResetRequest) => void>();
  readonly #agentMessage = new ListenerSlot<(message: AgentMessageDelivery) => void>();
  readonly #reminderSync = new ListenerSlot<(sync: ReminderSync) => void>();
  readonly #skillsList = new ListenerSlot<(request: AgentSkillsListRequest) => Promise<void>>();
  readonly #workspaceFilesList = new ListenerSlot<
    (request: AgentWorkspaceFilesListRequest) => Promise<void>
  >();
  readonly #workspaceFileRead = new ListenerSlot<
    (request: AgentWorkspaceFileReadRequest) => Promise<void>
  >();
  readonly #usageScan = new ListenerSlot<
    (request: DaemonRuntimeUsageScanRequest) => Promise<void>
  >();
  readonly #providerModelRefresh = new ListenerSlot<
    (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>
  >();
  readonly #agentContextScan = new ListenerSlot<
    (request: AgentContextScanRequest) => Promise<void>
  >();
  readonly #reconnect = new ListenerSlot<() => void>();
  /** Publications received between a ready request and its acknowledgement, in arrival order. */
  #readyPublications: Array<() => void> | undefined;
  #readyRequestFactory: (() => DaemonRuntimeReadyRequest) | undefined;
  #readyRecoveryClient: CentrifugeWorkspaceClient | undefined;
  #readyRetryTimer: unknown;
  #readyRetryAttempts = 0;
  /** When the current run of ready failures began, so a log line can say how long this machine has
   * been connected without a recovered Workspace. Cleared the moment ready succeeds. */
  #readyFailingSinceMs: number | undefined;
  readonly #pendingActivity = new Map<string, AgentActivity>();
  readonly #supersededActivityLaunches = new Map<string, Set<string>>();
  /** Latest-per-agent, like `#pendingActivity`. */
  readonly #pendingSessionInvalidate = new Map<string, AgentSessionInvalidate>();
  /** Raft's `observeLaunchIdentity`: the latest launch a *non*-Activity, non-invalidate
   * outbound message has reported for an Agent (today, only `reportAgentSession` carries a
   * `launchId`; `AgentStatus` does not). Drives `sendSessionInvalidate`'s drop/refuse-to-queue
   * rule below — deliberately not Activity's own `#supersededActivityLaunches` bookkeeping,
   * which stays exactly as it was for Activity replay. */
  readonly #latestObservedLaunchByAgent = new Map<string, string>();
  /** True once an old server's "unknown RPC method" rejection of `agent:session:invalidate` has
   * been logged; suppresses repeats for the rest of this connection's lifetime (fix for a log
   * line that used to repeat on every rejected attempt). */
  #loggedUnknownSessionInvalidateMethod = false;
  /** Latest-per-agent, like `#pendingSessionInvalidate`. No launch-observation drop
   * rule here: the server's own launch-fence gate already rejects a stale one, and a context
   * reading is superseded by the next one anyway. */
  readonly #pendingContextUsage = new Map<string, AgentContextUsage>();
  /** Same one-per-connection-lifetime log suppression as
   * `#loggedUnknownSessionInvalidateMethod`, for `agent:context:usage`. */
  #loggedUnknownContextUsageMethod = false;
  /** Same one-per-connection-lifetime log suppression as
   * `#loggedUnknownSessionInvalidateMethod`, for `agent:context_scan_result`. */
  #loggedUnknownContextScanResultMethod = false;
  readonly #latestStatuses = new Map<string, AgentStatus>();
  readonly #restartRequestIds = new Set<string>();
  readonly #upgradeRequestIds = new Set<string>();
  readonly #reportedUpgradeRequestIds = new Set<string>();
  #statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  #computerStatusRefreshTimer: unknown;
  /** When this connection last carried inbound traffic, by the connection's own clock. Only a
   * publication on the Daemon's channel or an answered status RPC sets it; an open socket does
   * not, which is the whole point. Undefined until the connection first reports connected. */
  #lastInboundAtMs: number | undefined;
  /** Same log suppression as `#loggedUnknownSessionInvalidateMethod`, but per quiet stretch
   * rather than per connection: cleared the moment anything arrives. */
  #loggedInboundQuiet = false;
  #statusRpcQueue = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly clientFactory: CentrifugeWorkspaceClientFactory = defaultCentrifugeWorkspaceClientFactory,
    private readonly agentMessageHttpClient: AgentMessageHttpClient = defaultAgentMessageHttpClient,
    private readonly timing: DaemonConnectionTiming = defaultDaemonConnectionTiming,
    private readonly agentTaskHttpClient: AgentTaskHttpClient = defaultAgentTaskHttpClient,
    private readonly agentWeeklyReportHttpClient: AgentWeeklyReportHttpClient = defaultAgentWeeklyReportHttpClient,
    private readonly agentChannelHttpClient: AgentChannelHttpClient = defaultAgentChannelHttpClient,
    private readonly agentActionPrepareHttpClient: AgentActionPrepareHttpClient = defaultAgentActionPrepareHttpClient,
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
    const daemonChannel = `daemon:${config.workspaceId}:${config.computerId}`;
    const scope = { workspace_id: config.workspaceId, computer_id: config.computerId };
    client.on("publication", ({ channel, data }) => {
      if (client !== this.#client || channel !== daemonChannel) return;
      // Before any decoding: a frame this Daemon cannot act on still proves the link carries
      // traffic, and the liveness window must not mistake an undecodable frame for silence.
      this.#markInbound();
      this.#handleAgentPublication(data, config);
    });
    client.on("disconnected", () => {
      if (client !== this.#client) return;
      this.#connected = false;
      this.#cancelReadyRecovery();
      logger.warning("Daemon cloud connection disconnected", {
        event: "daemon_connection:disconnected",
        ...scope,
      });
    });
    await new Promise<void>((resolve, reject) => {
      client.on("connected", () => {
        if (client !== this.#client) return;
        const reconnect = this.#hasConnected;
        this.#connected = true;
        this.#hasConnected = true;
        this.#markInbound();
        logger.info("Daemon cloud connection established", {
          event: "daemon_connection:connected",
          ...scope,
          control_stream_binding: "connect_proxy",
          outcome: "ok",
        });
        this.#reportOnline(client, config);
        // Invalidate before Activity on reconnect, as Raft does.
        this.#flushPendingSessionInvalidate(client);
        this.#flushPendingActivity(client);
        this.#flushPendingContextUsage(client);
        for (const status of this.#latestStatuses.values()) this.#queueAgentStatus(client, status);
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
          ...scope,
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
    return this.#agentStart.set(callback);
  }

  onAgentStop(callback: (intent: AgentStopIntent) => void): () => void {
    return this.#agentStop.set(callback);
  }

  onAgentActivityProbe(callback: (probe: AgentActivityProbe) => void): () => void {
    return this.#agentActivityProbe.set(callback);
  }

  onAgentInboxPurge(callback: (purge: AgentInboxPurge) => void): () => void {
    return this.#agentInboxPurge.set(callback);
  }

  onAgentMessage(callback: (message: AgentMessageDelivery) => void): () => void {
    return this.#agentMessage.set(callback);
  }

  onAgentWorkspaceReset(callback: (request: AgentWorkspaceResetRequest) => void): () => void {
    return this.#agentWorkspaceReset.set(callback);
  }

  onReminderSync(callback: (sync: ReminderSync) => void): () => void {
    return this.#reminderSync.set(callback);
  }

  onSkillsList(callback: (request: AgentSkillsListRequest) => Promise<void>): () => void {
    return this.#skillsList.set(callback);
  }

  onWorkspaceFilesList(
    callback: (request: AgentWorkspaceFilesListRequest) => Promise<void>,
  ): () => void {
    return this.#workspaceFilesList.set(callback);
  }

  onWorkspaceFileRead(
    callback: (request: AgentWorkspaceFileReadRequest) => Promise<void>,
  ): () => void {
    return this.#workspaceFileRead.set(callback);
  }

  onUsageScan(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void {
    return this.#usageScan.set(callback);
  }

  onProviderModelRefresh(
    callback: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
  ): () => void {
    return this.#providerModelRefresh.set(callback);
  }

  onAgentContextScan(callback: (request: AgentContextScanRequest) => Promise<void>): () => void {
    return this.#agentContextScan.set(callback);
  }

  onReconnect(callback: () => void): () => void {
    return this.#reconnect.set(callback);
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
    this.#publishActivity(this.#client, activity);
  }

  /** Fire-and-forget; never awaited by a caller and never fails a launch. */
  sendSessionInvalidate(message: AgentSessionInvalidate): void {
    if (this.#supersededActivityLaunches.get(message.agentId)?.has(message.launchId)) return;
    if (!this.#connected || !this.#client) {
      // Raft's rule: refuse to queue a new invalidate whose launch is already known stale —
      // never learned from Activity or from an invalidate itself, only from another outbound
      // message that carries launch identity (`#observeLaunchIdentity`).
      const observed = this.#latestObservedLaunchByAgent.get(message.agentId);
      if (observed !== undefined && observed !== message.launchId) return;
      this.#pendingSessionInvalidate.set(message.agentId, message);
      return;
    }
    this.#publishSessionInvalidate(this.#client, message);
  }

  /** Fire-and-forget; never awaited by a caller and never fails a turn. */
  sendAgentContextUsage(message: AgentContextUsage): void {
    if (!this.#connected || !this.#client) {
      this.#pendingContextUsage.set(message.agentId, message);
      return;
    }
    this.#publishContextUsage(this.#client, message);
  }

  sendAgentStatus(status: AgentStatus): void {
    this.#latestStatuses.set(status.agentId, status);
    if (this.#connected && this.#client) this.#queueAgentStatus(this.#client, status);
  }

  /**
   * Raft's `observeLaunchIdentity`: only an outbound message that is neither Activity nor a
   * session invalidate itself teaches this connection which launch is now current for an
   * Agent. Drops a pending invalidate whose launch differs from the one just observed — the
   * correctly-directional replacement for the old rule that dropped it on ANY differing-launch
   * Activity, including a late Activity from an OLDER launch that would have wrongly dropped a
   * NEWER pending invalidate.
   */
  #observeLaunchIdentity(agentId: string, launchId: string): void {
    this.#latestObservedLaunchByAgent.set(agentId, launchId);
    const pending = this.#pendingSessionInvalidate.get(agentId);
    if (pending && pending.launchId !== launchId) this.#pendingSessionInvalidate.delete(agentId);
  }

  #publishActivity(client: CentrifugeWorkspaceClient, activity: AgentActivity): void {
    // Activity is an observation. Failure must not block Agent work or be retried.
    void client
      .publish?.(`agent:activity:${activity.workspaceId}`, encodeAgentActivity(activity))
      .catch(() => {});
  }

  #flushPendingActivity(client: CentrifugeWorkspaceClient): void {
    if (!client.publish) return;
    const pending = [...this.#pendingActivity.values()];
    this.#pendingActivity.clear();
    this.#supersededActivityLaunches.clear();
    for (const activity of pending) this.#publishActivity(client, activity);
  }

  #publishSessionInvalidate(
    client: CentrifugeWorkspaceClient,
    message: AgentSessionInvalidate,
  ): void {
    // An observation, not a command: a rejection (including an old server that does not
    // recognize this RPC) is logged, never retried or surfaced to the caller.
    void client
      .rpc(AGENT_SESSION_INVALIDATE_METHOD, encodeAgentSessionInvalidate(message))
      .catch((error) => {
        const errorCode = diagnosticErrorCode(error);
        // An old server that has never heard of this RPC rejects every attempt the same way for
        // as long as this process talks to it; logging that fact once per connection lifetime is
        // enough. Any other rejection (a genuine, potentially transient failure) still logs every
        // time, like the sibling `agent_session:report_failed`.
        const unknownMethod = errorCode === "404";
        if (unknownMethod && this.#loggedUnknownSessionInvalidateMethod) return;
        if (unknownMethod) this.#loggedUnknownSessionInvalidateMethod = true;
        logger.warning("Agent session invalidate was not accepted", {
          event: "agent_session:invalidate_rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          computer_id: message.computerId,
          agent_id: message.agentId,
          launch_id: message.launchId,
          reason: message.reason,
          error_code: errorCode,
          outcome: "failed",
        });
      });
  }

  #flushPendingSessionInvalidate(client: CentrifugeWorkspaceClient): void {
    const pending = [...this.#pendingSessionInvalidate.values()];
    this.#pendingSessionInvalidate.clear();
    for (const message of pending) {
      if (this.#supersededActivityLaunches.get(message.agentId)?.has(message.launchId)) continue;
      this.#publishSessionInvalidate(client, message);
    }
  }

  #publishContextUsage(client: CentrifugeWorkspaceClient, message: AgentContextUsage): void {
    // An observation, not a command: a rejection (including an old server that does not
    // recognize this RPC) is logged, never retried or surfaced to the caller.
    void client.rpc(AGENT_CONTEXT_USAGE_METHOD, encodeAgentContextUsage(message)).catch((error) => {
      const errorCode = diagnosticErrorCode(error);
      // An old server that has never heard of this RPC rejects every attempt the same way for
      // as long as this process talks to it; logging that fact once per connection lifetime is
      // enough. Any other rejection (a genuinely transient failure) still logs every time.
      const unknownMethod = errorCode === "404";
      if (unknownMethod && this.#loggedUnknownContextUsageMethod) return;
      if (unknownMethod) this.#loggedUnknownContextUsageMethod = true;
      logger.warning("Agent context usage was not accepted", {
        event: "agent_context_usage:rejected",
        request_id: message.requestId,
        workspace_id: message.workspaceId,
        computer_id: message.computerId,
        agent_id: message.agentId,
        launch_id: message.launchId,
        error_code: errorCode,
        outcome: "failed",
      });
    });
  }

  #flushPendingContextUsage(client: CentrifugeWorkspaceClient): void {
    const pending = [...this.#pendingContextUsage.values()];
    this.#pendingContextUsage.clear();
    for (const message of pending) this.#publishContextUsage(client, message);
  }

  #queueAgentStatus(client: CentrifugeWorkspaceClient, status: AgentStatus): void {
    this.#statusRpcQueue = this.#statusRpcQueue
      .then(async () => {
        if (!this.#connected || client !== this.#client) return;
        await client.rpc(AGENT_STATUS_METHOD, encodeAgentStatus(status));
      })
      .catch(() => {});
  }

  #reportOnline(client: CentrifugeWorkspaceClient, config: DaemonConnectionConfig): void {
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
      this.#checkInboundLiveness(client, config);
      void client
        .rpc(
          DAEMON_CONNECTION_STATUS_METHOD,
          new TextEncoder().encode(JSON.stringify({ ...config, online: true })),
        )
        .then(() => {
          // An answered round trip is the only inbound traffic a Workspace with nothing to say
          // produces, so it is what keeps a legitimately quiet connection alive.
          if (client === this.#client) this.#markInbound();
        })
        .catch(() => {});
    };
    this.#computerStatusRefreshTimer = this.timing.scheduleRepeating
      ? this.timing.scheduleRepeating(refresh, COMPUTER_STATUS_REFRESH_MS)
      : setInterval(refresh, COMPUTER_STATUS_REFRESH_MS);
    if (!this.timing.scheduleRepeating) {
      (this.#computerStatusRefreshTimer as ReturnType<typeof setInterval>).unref();
    }
  }

  #nowMs(): number {
    return this.timing.now ? this.timing.now() : Date.now();
  }

  #markInbound(): void {
    this.#lastInboundAtMs = this.#nowMs();
    this.#loggedInboundQuiet = false;
  }

  /**
   * Decides, once per status refresh, whether this connection is still worth believing.
   *
   * A socket that stays open is not evidence that anything reaches this Daemon: the incident
   * this answers kept its socket and its subscription while every control frame it delivered was
   * dropped as undecodable, and the Agent behind it stayed silent until a person restarted the
   * Computer. Rebuilding the connection is the one recovery that does not need that person.
   */
  #checkInboundLiveness(client: CentrifugeWorkspaceClient, config: DaemonConnectionConfig): void {
    if (this.#lastInboundAtMs === undefined) return;
    const ageMs = this.#nowMs() - this.#lastInboundAtMs;
    const liveness = connectionLiveness(ageMs);
    if (liveness === "carrying") return;
    const scope = { workspace_id: config.workspaceId, computer_id: config.computerId };
    if (liveness === "quiet") {
      if (this.#loggedInboundQuiet) return;
      this.#loggedInboundQuiet = true;
      logger.info("Daemon cloud connection has carried nothing recently", {
        event: "daemon_connection:inbound_quiet",
        ...scope,
        last_inbound_age_ms: ageMs,
        rebuild_after_ms: INBOUND_STALLED_MS,
      });
      return;
    }
    logger.warning("Daemon cloud connection carried nothing; rebuilding it", {
      event: "daemon_connection:inbound_stalled",
      ...scope,
      last_inbound_age_ms: ageMs,
      outcome: "reconnecting",
    });
    // Counts as fresh traffic so a connection that takes a while to come back is rebuilt once
    // per window rather than on every refresh while it reconnects.
    this.#markInbound();
    client.disconnect();
    client.connect();
  }

  #requireClient(): CentrifugeWorkspaceClient {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    return this.#client;
  }

  /** Sends one RPC over the connected client and returns its raw reply. */
  #rpc(method: string, data: Uint8Array): Promise<unknown> {
    return this.#requireClient().rpc(method, data);
  }

  /** The server endpoint for one Agent HTTP path; `what` names the caller in the error. */
  #serverEndpoint(what: string, path: string): string {
    if (!this.#serverHttpUrl) throw new Error(`${what} endpoint is not configured`);
    return `${new URL(this.#serverHttpUrl).origin}${path}`;
  }

  async sendAgentDeliveryAck(ack: AgentMessageDeliveryAck): Promise<void> {
    await this.#rpc(AGENT_MESSAGE_ACK_METHOD, encodeAgentMessageDeliveryAck(ack));
  }

  /** Credentials for one Agent-scoped HTTP call: the Agent's own key plus the daemon key. */
  #agentKeys(agentApiKey: string) {
    return { agentApiKey, daemonApiKey: this.#token };
  }

  async agentMessage(
    request: AgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageTransportResponse> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    const {
      requestRead,
      requestSearch,
      requestSend,
      requestResolve,
      requestReaction,
      requestEvents,
      requestChannelMute,
      requestThreadUnfollow,
    } = this.agentMessageHttpClient;
    if (request.operation === "check") {
      if (!requestEvents) throw new Error("unsupported Agent message operation: check");
      const url = this.#serverEndpoint("Agent message HTTP", agentApiRoutes.cloud.events.path);
      const events = await requestEvents({ url, ...this.#agentKeys(agentApiKey), request });
      return {
        protocolMajor: events.protocolMajor,
        requestId: events.idempotencyKey,
        accepted: true,
        attentionCount: events.events.length,
        messages: events.events,
        messageId: "",
        hasMore: events.hasMore,
      };
    }
    if (request.operation === "mute" || request.operation === "unmute") {
      if (!requestChannelMute)
        throw new Error(`unsupported Agent message operation: ${request.operation}`);
      const muted = request.operation === "mute";
      const path = muted
        ? agentApiRoutes.cloud.channels.mute.path(request.target)
        : agentApiRoutes.cloud.channels.unmute.path(request.target);
      const url = this.#serverEndpoint("Agent message HTTP", path);
      const result = await requestChannelMute({
        url,
        ...this.#agentKeys(agentApiKey),
        request: { ...request, muted },
      });
      return {
        protocolMajor: result.protocolMajor,
        requestId: result.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
        messageId: "",
      };
    }
    if (request.operation === "thread-unfollow") {
      if (!requestThreadUnfollow)
        throw new Error("unsupported Agent message operation: thread-unfollow");
      const url = this.#serverEndpoint(
        "Agent message HTTP",
        agentApiRoutes.cloud.threads.unfollow.path(request.target),
      );
      const result = await requestThreadUnfollow({ url, ...this.#agentKeys(agentApiKey), request });
      return {
        protocolMajor: result.protocolMajor,
        requestId: result.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
        messageId: "",
      };
    }
    if (request.operation === "resolve") {
      if (!requestResolve) throw new Error("unsupported Agent message operation: resolve");
      const url = this.#serverEndpoint(
        "Agent message HTTP",
        agentApiRoutes.cloud.messages.resolve.path(request.messageId ?? ""),
      );
      return adaptAgentResolveResponse(
        await requestResolve({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "react" || request.operation === "unreact") {
      if (!requestReaction)
        throw new Error(`unsupported Agent message operation: ${request.operation}`);
      const url = this.#serverEndpoint(
        "Agent message HTTP",
        agentApiRoutes.cloud.messages.reactions.path(request.messageId ?? ""),
      );
      const method =
        request.operation === "react"
          ? agentApiRoutes.cloud.messages.reactions.add.method
          : agentApiRoutes.cloud.messages.reactions.remove.method;
      return adaptAgentReactionResponse(
        await requestReaction({ url, method, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "read") {
      if (!requestRead) throw new Error("unsupported Agent message operation: read");
      const url = this.#serverEndpoint(
        "Agent message HTTP",
        agentApiRoutes.cloud.messages.list.path,
      );
      return adaptAgentHistoryResponse(
        await requestRead({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "search") {
      if (!requestSearch) throw new Error("unsupported Agent message operation: search");
      const url = this.#serverEndpoint(
        "Agent message HTTP",
        agentApiRoutes.cloud.messages.search.path,
      );
      return adaptAgentSearchResponse(
        await requestSearch({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "send") {
      if (!requestSend) throw new Error("unsupported Agent message operation: send");
      const url = this.#serverEndpoint(
        "Agent message HTTP",
        agentApiRoutes.cloud.messages.send.path,
      );
      return adaptAgentSendResponse(
        await requestSend({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    throw new Error(`unsupported Agent message operation: ${request.operation}`);
  }

  async workspaceInfo(
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent workspace_info HTTP endpoint is not configured");
    if (!this.agentMessageHttpClient.requestWorkspaceInfo)
      throw new Error("Agent workspace_info HTTP client is unavailable");
    return this.agentMessageHttpClient.requestWorkspaceInfo({
      url: this.#serverEndpoint("Agent workspace_info", agentApiRoutes.cloud.workspace.info.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async githubCredential(request: GitHubCredentialRequest, agentApiKey: string) {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("GitHub credential endpoint is not configured");
    if (!this.agentMessageHttpClient.requestGitHubCredential)
      throw new Error("GitHub credential HTTP client is unavailable");
    return this.agentMessageHttpClient.requestGitHubCredential({
      url: this.#serverEndpoint("GitHub credential", agentApiRoutes.cloud.githubCredentials.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async githubCommitTrailers(request: GitHubCommitTrailersRequest, agentApiKey: string) {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("GitHub commit trailers endpoint is not configured");
    if (!this.agentMessageHttpClient.requestGitHubCommitTrailers)
      throw new Error("GitHub commit trailers HTTP client is unavailable");
    return this.agentMessageHttpClient.requestGitHubCommitTrailers({
      url: this.#serverEndpoint(
        "GitHub commit trailers",
        agentApiRoutes.cloud.githubCommitTrailers.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async manualGet(
    request: AgentManualGetRequest,
    agentApiKey: string,
  ): Promise<AgentManualGetResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent Manual endpoint is not configured");
    if (!this.agentMessageHttpClient.requestManualGet)
      throw new Error("Agent Manual HTTP client is unavailable");
    return this.agentMessageHttpClient.requestManualGet({
      url: this.#serverEndpoint("Agent manual get", agentApiRoutes.cloud.manual.get.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async manualSearch(
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent Manual endpoint is not configured");
    if (!this.agentMessageHttpClient.requestManualSearch)
      throw new Error("Agent Manual HTTP client is unavailable");
    return this.agentMessageHttpClient.requestManualSearch({
      url: this.#serverEndpoint("Agent manual search", agentApiRoutes.cloud.manual.search.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async userInfo(
    request: AgentUserInfoRequest,
    agentApiKey: string,
  ): Promise<AgentUserInfoResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent user info endpoint is not configured");
    if (!this.agentMessageHttpClient.requestUserInfo)
      throw new Error("Agent user info HTTP client is unavailable");
    return this.agentMessageHttpClient.requestUserInfo({
      url: this.#serverEndpoint("Agent user info", agentApiRoutes.cloud.users.path(request.name)),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async profileShow(
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent profile endpoint is not configured");
    if (!this.agentMessageHttpClient.requestProfileShow)
      throw new Error("Agent profile HTTP client is unavailable");
    return this.agentMessageHttpClient.requestProfileShow({
      url: this.#serverEndpoint("Agent profile show", agentApiRoutes.cloud.profile.get.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async profileUpdate(
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent profile endpoint is not configured");
    if (!this.agentMessageHttpClient.requestProfileUpdate)
      throw new Error("Agent profile HTTP client is unavailable");
    return this.agentMessageHttpClient.requestProfileUpdate({
      url: this.#serverEndpoint("Agent profile update", agentApiRoutes.cloud.profile.update.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async mentionPending(agentApiKey: string): Promise<AgentMentionPendingResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent mention actions endpoint is not configured");
    if (!this.agentMessageHttpClient.requestMentionPending)
      throw new Error("Agent mention actions HTTP client is unavailable");
    return this.agentMessageHttpClient.requestMentionPending({
      url: this.#serverEndpoint(
        "Agent mention pending",
        agentApiRoutes.cloud.mentionActions.pending.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request: {},
    });
  }

  async mentionExecute(
    request: AgentMentionExecuteRequest,
    agentApiKey: string,
  ): Promise<AgentMentionExecuteResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent mention actions endpoint is not configured");
    if (!this.agentMessageHttpClient.requestMentionExecute)
      throw new Error("Agent mention actions HTTP client is unavailable");
    return this.agentMessageHttpClient.requestMentionExecute({
      url: this.#serverEndpoint(
        "Agent mention action",
        agentApiRoutes.cloud.mentionActions.execute.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentReminder(request: AgentReminderOperationRequest, agentApiKey: string) {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("daemon connection is not connected");
    if (!this.agentMessageHttpClient.requestReminder)
      throw new Error("Agent reminder HTTP client is unavailable");
    const response = await this.agentMessageHttpClient.requestReminder({
      url: this.#serverEndpoint("Agent reminder", agentApiRoutes.cloud.reminders.path),
      agentApiKey,
      daemonApiKey: this.#token,
      request,
    });
    for (const field of [
      "requestId",
      "workspaceId",
      "computerId",
      "agentId",
      "protocolMajor",
    ] as const)
      if (response[field] !== request[field])
        throw new Error("uncorrelated Agent reminder response");
    return response;
  }

  async fireReminder(request: ReminderFireRequest): Promise<ReminderFireResponse> {
    const reply = await this.#rpc(REMINDER_FIRE_METHOD, encodeReminderFireRequest(request));
    return decodeReminderFireResponse(rpcData(reply));
  }

  async requestSnapshot(request: ReminderSnapshotRequest): Promise<ReminderSync> {
    const reply = await this.#rpc(REMINDER_SNAPSHOT_METHOD, encodeReminderSnapshotRequest(request));
    return decodeReminderSync(rpcData(reply));
  }

  async agentTask(request: TaskRequest, agentApiKey: string): Promise<TaskResponse> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return this.agentTaskHttpClient.execute({
      url: this.#serverEndpoint("Agent Task HTTP", agentApiRoutes.cloud.tasks.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentChannel(
    request: AgentChannelRequest,
    agentApiKey: string,
  ): Promise<Record<string, unknown>> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    const endpoint = channelEndpointFor(request.operation, request.target);
    return this.agentChannelHttpClient.execute({
      method: endpoint.method,
      url: this.#serverEndpoint("Agent channel", endpoint.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentActionPrepare(
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return this.agentActionPrepareHttpClient.execute({
      url: this.#serverEndpoint(
        "Agent action-prepare HTTP",
        agentApiRoutes.cloud.actionPrepare.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentWeeklyReport(
    request: WeeklyReportRequest,
    agentApiKey: string,
  ): Promise<WeeklyReportResponse> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return this.agentWeeklyReportHttpClient.request({
      url: this.#serverEndpoint(
        "Agent weekly-report HTTP",
        agentApiRoutes.cloud.weeklyReports.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentWeeklyReportCollect(
    request:
      | import("./weekly-report-collect").WeeklyReportCollectCommand
      | import("./weekly-report-collect").WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-collect").WeeklyReportCollectResult> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return defaultAgentWeeklyReportCollectHttpClient.execute({
      url: this.#serverEndpoint(
        "Agent weekly-report-collect HTTP",
        agentApiRoutes.cloud.weeklyReportCollect.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentWeeklyReportKeyPoints(
    request: import("./weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-key-points").WeeklyReportKeyPointsResult> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return defaultAgentWeeklyReportKeyPointsHttpClient.execute({
      url: this.#serverEndpoint(
        "Agent weekly-report-key-points HTTP",
        agentApiRoutes.cloud.weeklyReportKeyPoints.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentAttachment(attachmentId: string, agentApiKey: string): Promise<Response> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return fetch(
      this.#serverEndpoint("Agent attachment", agentApiRoutes.cloud.attachments.path(attachmentId)),
      { headers: agentHeaders(this.#agentKeys(agentApiKey)) },
    );
  }

  /**
   * Forwards a multipart upload to the cloud attachment-upload route. Buffered to a `Blob`
   * rather than streamed: the local proxy already caps the body well under the size the daemon
   * can hold in memory, and buffering avoids depending on `duplex: "half"` for a streamed
   * `fetch` body. The original request's `content-type` (its multipart boundary) is forwarded
   * unchanged; only the Agent-scoped authorization headers are added.
   */
  async agentAttachmentUpload(request: Request, agentApiKey: string): Promise<Response> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    const contentType = request.headers.get("content-type");
    if (!contentType) throw new Error("multipart content-type is missing");
    const body = await request.blob();
    return fetch(
      this.#serverEndpoint("Agent attachment upload", agentApiRoutes.cloud.attachments.upload.path),
      {
        method: agentApiRoutes.cloud.attachments.upload.method,
        headers: { ...agentHeaders(this.#agentKeys(agentApiKey)), "content-type": contentType },
        body,
      },
    );
  }

  /**
   * The direct-upload session routes are plain JSON, unlike the multipart upload
   * above; each simply forwards its body (if any) to the matching cloud route with the same
   * Agent-scoped headers `agentAttachment`/`agentAttachmentUpload` already add.
   */
  async agentAttachmentUploadSessionCreate(body: unknown, agentApiKey: string): Promise<Response> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session create",
        agentApiRoutes.cloud.attachmentUploadSessions.create.path,
      ),
      {
        method: agentApiRoutes.cloud.attachmentUploadSessions.create.method,
        headers: agentHeaders(this.#agentKeys(agentApiKey), true),
        body: JSON.stringify(body),
      },
    );
  }

  async agentAttachmentUploadSessionComplete(
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session complete",
        agentApiRoutes.cloud.attachmentUploadSessions.complete.path(uploadId),
      ),
      {
        method: agentApiRoutes.cloud.attachmentUploadSessions.complete.method,
        headers: agentHeaders(this.#agentKeys(agentApiKey)),
      },
    );
  }

  async agentAttachmentUploadSessionCancel(
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session cancel",
        agentApiRoutes.cloud.attachmentUploadSessions.cancel.path(uploadId),
      ),
      {
        method: agentApiRoutes.cloud.attachmentUploadSessions.cancel.method,
        headers: agentHeaders(this.#agentKeys(agentApiKey)),
      },
    );
  }

  async agentAttachmentUploadSessionGet(uploadId: string, agentApiKey: string): Promise<Response> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session get",
        agentApiRoutes.cloud.attachmentUploadSessions.get.path(uploadId),
      ),
      { headers: agentHeaders(this.#agentKeys(agentApiKey)) },
    );
  }

  /** One request against the Agent API key endpoint; `what` names the caller in errors. */
  async #agentApiKeyRequest(what: string, method: "POST" | "DELETE", body: unknown) {
    const response = await fetch(this.#serverEndpoint(what, "/api/agent-api-keys"), {
      method,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${what} request failed (${response.status})`);
    return response;
  }

  async requestAgentApiKey(input: { agentId: string; workspaceId: string }): Promise<string> {
    const value = (await (
      await this.#agentApiKeyRequest("Agent API key", "POST", input)
    ).json()) as {
      apiKey?: unknown;
    };
    return parseAgentApiKey(value.apiKey);
  }

  async requestAgentLaunchConfig(input: {
    agentId: string;
    workspaceId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
  }): Promise<AgentLaunchConfig> {
    const value = (await (
      await this.#agentApiKeyRequest("Agent launch config", "POST", input)
    ).json()) as {
      apiKey?: unknown;
      providerConfig?: unknown;
      envVars?: unknown;
      assignedSkillPacks?: unknown;
      identity?: unknown;
    };
    const providerConfig = parseAgentRuntimeProviderConfig(value.providerConfig);
    const assignedSkillPacks = Array.isArray(value.assignedSkillPacks)
      ? value.assignedSkillPacks.filter((entry): entry is string => typeof entry === "string")
      : [];
    const identity = parseAgentLaunchIdentity(value.identity);
    return {
      agentApiKey: parseAgentApiKey(value.apiKey),
      ...(providerConfig ? { providerConfig } : {}),
      envVars: parseAgentEnvironment(value.envVars),
      ...(assignedSkillPacks.length > 0 ? { assignedSkillPacks } : {}),
      ...(identity ? { identity } : {}),
    };
  }

  async revokeAgentApiKey(agentApiKey: string): Promise<void> {
    await this.#agentApiKeyRequest("Agent API key revoke", "DELETE", { apiKey: agentApiKey });
  }

  /** Delivers to a listener now, or after the in-flight ready handshake completes. */
  #deliver<Value>(slot: ListenerSlot<(value: Value) => void>, value: Value): void {
    if (this.#readyPublications) this.#readyPublications.push(() => slot.current?.(value));
    else slot.current?.(value);
  }

  /**
   * Decodes `data` as one publication kind and lets `accept` handle it. Returns whether the
   * publication was consumed; a decode failure or a rejected `accept` moves on to the next kind.
   */
  #route<Value>(
    data: Uint8Array,
    decode: (data: Uint8Array) => Value,
    accept: (value: Value) => boolean,
  ) {
    try {
      return accept(decode(data));
    } catch {
      return false;
    }
  }

  /** Runs one Computer lifecycle request at most once per request ID. */
  #acceptLifecycleRequest(seen: Set<string>, requestId: string, run: () => Promise<void>): void {
    if (seen.size >= REMEMBERED_REQUEST_IDS) seen.delete(seen.values().next().value!);
    seen.add(requestId);
    try {
      void run().catch(() => {
        seen.delete(requestId);
      });
    } catch (error) {
      seen.delete(requestId);
      throw error;
    }
  }

  #handleAgentPublication(data: Uint8Array, config: DaemonConnectionConfig): void {
    const { workspaceId, computerId } = config;
    const ownsDaemon = (value: { workspaceId: string; computerId?: string }) =>
      value.workspaceId === workspaceId && value.computerId === computerId;
    const handled =
      this.#route(data, decodeReminderSync, (sync) => {
        if (sync.messageType !== REMINDER_SYNC_MESSAGE_TYPE || !ownsDaemon(sync)) return false;
        this.#deliver(this.#reminderSync, sync);
        return true;
      }) ||
      this.#route(data, decodeComputerUpgradeIntent, (upgrade) => {
        const requestUpgrade = config.requestUpgrade;
        if (
          upgrade.protocolMajor !== 1 ||
          !ownsDaemon(upgrade) ||
          !requestUpgrade ||
          this.#upgradeRequestIds.has(upgrade.requestId)
        )
          return false;
        this.#acceptLifecycleRequest(this.#upgradeRequestIds, upgrade.requestId, () =>
          requestUpgrade(upgrade.requestId, upgrade.expectedVersion),
        );
        return true;
      }) ||
      this.#route(data, decodeComputerRestartIntent, (restart) => {
        const requestRestart = config.requestRestart;
        if (
          restart.protocolMajor !== 1 ||
          !ownsDaemon(restart) ||
          !requestRestart ||
          this.#restartRequestIds.has(restart.requestId)
        )
          return false;
        this.#acceptLifecycleRequest(this.#restartRequestIds, restart.requestId, () =>
          requestRestart(restart.requestId),
        );
        return true;
      }) ||
      this.#route(data, decodeAgentWorkspaceResetRequest, (request) => {
        if (request.workspaceId === workspaceId) this.#deliver(this.#agentWorkspaceReset, request);
        return true;
      }) ||
      this.#route(data, decodeAgentSkillsListRequest, (request) => {
        if (request.workspaceId === workspaceId)
          void this.#skillsList.current?.(request).catch(() => {});
        return true;
      }) ||
      this.#route(data, decodeAgentWorkspaceFilesListRequest, (request) => {
        if (request.workspaceId === workspaceId)
          void this.#workspaceFilesList.current?.(request).catch(() => {});
        return true;
      }) ||
      this.#route(data, decodeAgentWorkspaceFileReadRequest, (request) => {
        if (request.workspaceId === workspaceId)
          void this.#workspaceFileRead.current?.(request).catch(() => {});
        return true;
      }) ||
      this.#route(data, decodeDaemonRuntimeUsageScanRequest, (usage) => {
        if (usage.protocolMajor !== 1 || usage.workspaceId !== workspaceId || !usage.computerId)
          return false;
        void this.#usageScan.current?.(usage);
        return true;
      }) ||
      this.#route(data, decodeDaemonRuntimeProviderModelRefreshRequest, (refresh) => {
        if (
          refresh.protocolMajor !== 1 ||
          refresh.workspaceId !== workspaceId ||
          !refresh.computerId
        )
          return false;
        void this.#providerModelRefresh.current?.(refresh);
        return true;
      }) ||
      this.#route(data, decodeAgentContextScanRequest, (scan) => {
        if (scan.protocolMajor !== 1 || scan.workspaceId !== workspaceId || !scan.computerId)
          return false;
        void this.#agentContextScan.current?.(scan);
        return true;
      }) ||
      this.#route(data, decodeAgentActivityProbe, (probe) => {
        if (probe.protocolMajor !== 1 || !ownsDaemon(probe)) return false;
        this.#deliver(this.#agentActivityProbe, probe);
        return true;
      }) ||
      this.#route(data, decodeAgentInboxPurge, (purge) => {
        if (purge.protocolMajor !== 1 || !ownsDaemon(purge)) return false;
        this.#deliver(this.#agentInboxPurge, purge);
        return true;
      });
    if (handled) return;
    // Agent publications are the common case and must decode as exactly one intent kind.
    const decoders = [
      {
        kind: "agent_message",
        decode: () =>
          this.#deliver(
            this.#agentMessage,
            this.#ownedIntent(decodeAgentMessageDelivery(data), workspaceId),
          ),
      },
      {
        kind: "agent_stop",
        decode: () =>
          this.#deliver(
            this.#agentStop,
            this.#ownedIntent(decodeAgentStopIntent(data), workspaceId),
          ),
      },
      {
        kind: "agent_start",
        decode: () =>
          this.#deliver(
            this.#agentStart,
            this.#ownedIntent(decodeAgentStartIntent(data), workspaceId),
          ),
      },
    ];
    const rejections: { kind: string; error: unknown }[] = [];
    for (const { kind, decode } of decoders) {
      try {
        decode();
        return;
      } catch (error) {
        rejections.push({ kind, error });
      }
    }
    // Invalid publications are rejected at the protocol boundary and never reach the runtime.
    logger.warning("Rejected invalid Daemon control publication", {
      event: "daemon_control:rejected",
      workspace_id: workspaceId,
      computer_id: computerId,
      payload_bytes: data.byteLength,
      // Every decoder's own account, not just the last one's: each refuses for its own reason,
      // and reporting only the final attempt named a cause that belonged to a frame kind this
      // publication may never have been. An Agent that never woke leaves nothing else behind.
      rejections: rejections
        .map(
          ({ kind, error }) => `${kind}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("; "),
      // The fields the payload carries, never their values, so a frame no decoder accepted can
      // still be matched against a schema without putting message text in the log.
      payload_shape: controlPayloadShape(data),
      error_code: diagnosticErrorCode(rejections.at(-1)?.error),
      outcome: "rejected",
    });
  }

  #ownedIntent<Intent extends { protocolMajor: number; workspaceId: string }>(
    intent: Intent,
    workspaceId: string,
  ): Intent {
    if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId)
      throw new Error("agent intent targets another Workspace");
    return intent;
  }

  async sendAgentControlResult(result: AgentControlResult) {
    await this.#rpc(AGENT_CONTROL_RESULT_METHOD, encodeAgentControlResult(result));
  }

  async sendSkillsListResult(result: AgentSkillsListResult): Promise<void> {
    await this.#rpc(AGENT_SKILLS_LIST_RESULT_METHOD, encodeAgentSkillsListResult(result));
  }

  async sendWorkspaceFilesListResult(result: AgentWorkspaceFilesListResult): Promise<void> {
    await this.#rpc(
      AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
      encodeAgentWorkspaceFilesListResult(result),
    );
  }

  async sendWorkspaceFileReadResult(result: AgentWorkspaceFileReadResult): Promise<void> {
    await this.#rpc(
      AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
      encodeAgentWorkspaceFileReadResult(result),
    );
  }

  /**
   * Reports one upgrade operation's terminal result. Returns whether this call was the one that
   * put it on the wire; a replay of an already reported operation is dropped, and a failed send
   * stays replayable, matching the dedupe discipline of the other lifecycle results.
   */
  async sendUpgradeResult(result: ComputerUpgradeResult): Promise<boolean> {
    if (this.#reportedUpgradeRequestIds.has(result.requestId)) return false;
    await this.#rpc(COMPUTER_UPGRADE_RESULT_METHOD, encodeComputerUpgradeResult(result));
    if (this.#reportedUpgradeRequestIds.size >= REMEMBERED_REQUEST_IDS)
      this.#reportedUpgradeRequestIds.delete(
        this.#reportedUpgradeRequestIds.values().next().value!,
      );
    this.#reportedUpgradeRequestIds.add(result.requestId);
    return true;
  }

  async sendUsageScanResult(response: DaemonRuntimeUsageScanResponse): Promise<void> {
    await this.#rpc(
      DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
      encodeDaemonRuntimeUsageScanResponse(response),
    );
  }

  async sendProviderModelRefreshResult(
    response: DaemonRuntimeProviderModelRefreshResponse,
  ): Promise<void> {
    await this.#rpc(
      DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
      encodeDaemonRuntimeProviderModelRefreshResponse(response),
    );
  }

  async sendAgentContextScanResult(response: AgentContextScanResponse): Promise<void> {
    await this.#rpc(
      AGENT_CONTEXT_SCAN_RESULT_METHOD,
      encodeAgentContextScanResponse(response),
    ).catch((error) => {
      const errorCode = diagnosticErrorCode(error);
      // An old server that has never heard of this RPC rejects every attempt the same way for
      // as long as this process talks to it; logging that fact once per connection lifetime is
      // enough (the same convention as `agent_session:invalidate_rejected`). The scan itself
      // already completed on the Computer; only its delivery to the server failed.
      const unknownMethod = errorCode === "404";
      if (unknownMethod && this.#loggedUnknownContextScanResultMethod) return;
      if (unknownMethod) this.#loggedUnknownContextScanResultMethod = true;
      logger.warning("Agent context scan result was not accepted", {
        event: "agent_context_scan_result:rejected",
        request_id: response.requestId,
        workspace_id: response.workspaceId,
        computer_id: response.computerId,
        agent_id: response.agentId,
        status: response.status,
        error_code: errorCode,
        outcome: "failed",
      });
    });
  }

  async ready(createRequest: () => DaemonRuntimeReadyRequest): Promise<void> {
    const client = this.#requireClient();
    this.#readyPublications = [];
    const request = createRequest();
    const scope = {
      request_id: request.requestId,
      workspace_id: request.workspaceId,
      computer_id: request.computerId,
    };
    try {
      await this.#sendReady(client, request);
      this.#readyRequestFactory = createRequest;
      logger.info("Daemon ready recovery completed", {
        event: "daemon_ready:completed",
        ...scope,
        running_agent_count: request.runningAgentIds.length,
        outcome: "ok",
      });
    } catch (error) {
      logger.error("Daemon ready recovery failed", {
        event: "daemon_ready:failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      throw error;
    } finally {
      this.#dispatchReadyPublications();
    }
  }

  async updateCodeAgents(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void> {
    await this.#rpc(
      DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
      encodeDaemonRuntimeCodeAgentsUpdateRequest(request),
    );
  }

  async reportAgentSession(report: AgentSessionReport): Promise<void> {
    // Observed regardless of what follows: this is the daemon's own outbound intent to report
    // this launch, the signal `#observeLaunchIdentity` needs, independent of whether the RPC
    // below reaches the server.
    this.#observeLaunchIdentity(report.agentId, report.launchId);
    const client = this.#requireClient();
    try {
      await client.rpc(AGENT_SESSION_METHOD, encodeAgentSessionReport(report));
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
    const recovering = () =>
      client === this.#client && client === this.#readyRecoveryClient && this.#connected;
    if (!recovering()) return;
    const request = createRequest();
    try {
      await this.#sendReady(client, request);
    } catch (error) {
      if (!recovering()) return;
      // Doubles per failed attempt so an outage is not hammered once a second per daemon.
      const delayMs = Math.min(
        RECONNECT_READY_RETRY_MAX_MS,
        RECONNECT_READY_RETRY_MS * 2 ** this.#readyRetryAttempts,
      );
      this.#readyRetryAttempts += 1;
      this.#readyFailingSinceMs ??= Date.now();
      const stage = readyFailureStage(error);
      const details = {
        event: "daemon_ready:retry_scheduled",
        request_id: request.requestId,
        workspace_id: request.workspaceId,
        computer_id: request.computerId,
        error_code: diagnosticErrorCode(error),
        // Which step of the server's ready the failure came from, when it said so. Named here so
        // the failing machine's own log explains itself instead of requiring server logs.
        ...(stage ? { server_stage: stage } : {}),
        retry_delay_ms: delayMs,
        attempt: this.#readyRetryAttempts,
        failing_for_ms: Date.now() - this.#readyFailingSinceMs,
      };
      // Retrying forever at WARN hid a 13-hour outage on 2026-09-18: the connection stayed up, so
      // nothing looked wrong, while no Agent on the machine could be reached.
      if (
        this.#readyRetryAttempts >= READY_RETRY_ESCALATE_AFTER &&
        (this.#readyRetryAttempts === READY_RETRY_ESCALATE_AFTER ||
          this.#readyRetryAttempts % READY_RETRY_ESCALATE_EVERY === 0)
      )
        logger.error(
          "Daemon reconnect recovery keeps failing: this Computer is connected but its Workspace is not recovered, so its Agents cannot be reached",
          details,
        );
      else logger.warning("Daemon reconnect recovery will retry", details);
      this.#readyRetryTimer = this.timing.schedule(() => {
        this.#readyRetryTimer = undefined;
        void this.#attemptReadyRecovery(client, createRequest);
      }, delayMs);
      return;
    }
    if (!recovering()) return;
    if (this.#readyFailingSinceMs !== undefined)
      logger.info("Daemon reconnect recovery succeeded after failing", {
        event: "daemon_ready:recovered",
        request_id: request.requestId,
        workspace_id: request.workspaceId,
        computer_id: request.computerId,
        attempts: this.#readyRetryAttempts,
        failed_for_ms: Date.now() - this.#readyFailingSinceMs,
      });
    this.#readyFailingSinceMs = undefined;
    this.#readyRetryAttempts = 0;
    this.#readyRecoveryClient = undefined;
    this.#dispatchReadyPublications();
    this.#reconnect.current?.();
  }

  #cancelReadyRecovery(): void {
    if (this.#readyRetryTimer !== undefined) this.timing.cancel(this.#readyRetryTimer);
    this.#readyRetryTimer = undefined;
    this.#readyRetryAttempts = 0;
    this.#readyRecoveryClient = undefined;
  }

  #dispatchReadyPublications(): void {
    const publications = this.#readyPublications;
    this.#readyPublications = undefined;
    for (const dispatch of publications ?? []) dispatch();
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
    for (const slot of [
      this.#agentStart,
      this.#agentStop,
      this.#agentActivityProbe,
      this.#agentInboxPurge,
      this.#agentWorkspaceReset,
      this.#agentMessage,
      this.#reminderSync,
      this.#reconnect,
    ])
      slot.clear();
    this.#readyPublications = undefined;
    this.#readyRequestFactory = undefined;
    for (const collection of [
      this.#pendingActivity,
      this.#supersededActivityLaunches,
      this.#latestStatuses,
      this.#restartRequestIds,
      this.#upgradeRequestIds,
      this.#reportedUpgradeRequestIds,
      this.#latestObservedLaunchByAgent,
      this.#pendingContextUsage,
    ])
      collection.clear();
    this.#loggedUnknownSessionInvalidateMethod = false;
    this.#loggedUnknownContextUsageMethod = false;
    this.#statusRpcQueue = Promise.resolve();
    client?.disconnect();
  }
}

function rpcData(reply: unknown): Uint8Array {
  if (!reply || typeof reply !== "object" || !("data" in reply))
    throw new Error("missing RPC response payload");
  const data = (reply as { data?: unknown }).data;
  if (!(data instanceof Uint8Array)) throw new Error("invalid RPC response payload");
  return data;
}

function parseAgentApiKey(value: unknown): string {
  if (typeof value !== "string" || !isAgentApiKey(value))
    throw new Error("invalid Agent API key response");
  return value;
}

function parseAgentEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const invalid = () => new Error("invalid Agent environment response");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const entries = Object.entries(value);
  if (entries.length > 64 || JSON.stringify(value).length > 131_072) throw invalid();
  const envVars: Record<string, string> = Object.create(null);
  for (const [name, entry] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      name.length > 128 ||
      name.toUpperCase() === "PATH" ||
      name.toUpperCase().startsWith("COFORGE_") ||
      typeof entry !== "string" ||
      entry.includes("\0") ||
      entry.length > 32_768
    )
      throw invalid();
    envVars[name] = entry;
  }
  return envVars;
}

const IDENTITY_NAME_MAX_LENGTH = 80;
const IDENTITY_DESCRIPTION_MAX_LENGTH = 2000;
const IDENTITY_OTHER_MAX_LENGTH = 200;

/** A trimmed, length-capped wire string, or `undefined` for anything else (wrong type, empty
 * after trimming, or over the cap) — never a thrown error, so one bad field never invalidates
 * the rest of `identity`. */
function parseIdentityString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function parseIdentityRuntimeContext(
  value: unknown,
): AgentLaunchIdentity["runtimeContext"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const runtimeContext = {
    workspaceId: parseIdentityString(record.workspaceId, IDENTITY_OTHER_MAX_LENGTH),
    workspaceSlug: parseIdentityString(record.workspaceSlug, IDENTITY_OTHER_MAX_LENGTH),
    workspaceName: parseIdentityString(record.workspaceName, IDENTITY_OTHER_MAX_LENGTH),
    computerId: parseIdentityString(record.computerId, IDENTITY_OTHER_MAX_LENGTH),
    computerName: parseIdentityString(record.computerName, IDENTITY_OTHER_MAX_LENGTH),
    computerHostname: parseIdentityString(record.computerHostname, IDENTITY_OTHER_MAX_LENGTH),
    computerOs: parseIdentityString(record.computerOs, IDENTITY_OTHER_MAX_LENGTH),
    computerVersion: parseIdentityString(record.computerVersion, IDENTITY_OTHER_MAX_LENGTH),
  };
  const present = Object.fromEntries(
    Object.entries(runtimeContext).filter(([, entry]) => entry !== undefined),
  );
  return Object.keys(present).length > 0
    ? (present as AgentLaunchIdentity["runtimeContext"])
    : undefined;
}

/**
 * Decodes the launch-config response's optional `identity` field defensively: every field is
 * optional and string-only on the wire, so an older Web (no `identity` at all) or a newer Web
 * (fields this Daemon does not understand yet) both still launch normally. Unlike
 * `parseAgentRuntimeProviderConfig`/`parseAgentApiKey`, an invalid shape never throws — it
 * degrades to `undefined` (or drops just the invalid sub-field) so a malformed or missing
 * identity never fails the launch, only the standing prompt's identity-derived text.
 */
function parseAgentLaunchIdentity(value: unknown): AgentLaunchIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity: AgentLaunchIdentity = {
    name: parseIdentityString(record.name, IDENTITY_NAME_MAX_LENGTH),
    displayName: parseIdentityString(record.displayName, IDENTITY_NAME_MAX_LENGTH),
    description: parseIdentityString(record.description, IDENTITY_DESCRIPTION_MAX_LENGTH),
    runtimeContext: parseIdentityRuntimeContext(record.runtimeContext),
  };
  const present = Object.fromEntries(
    Object.entries(identity).filter(([, entry]) => entry !== undefined),
  );
  return Object.keys(present).length > 0 ? (present as AgentLaunchIdentity) : undefined;
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
