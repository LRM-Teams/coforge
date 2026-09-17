import { Centrifuge } from "centrifuge/build/protobuf";
import { agentApiRoutes, decodeGitHubCredentialResponse } from "@lrm/coforge-sdk/agent";
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
} from "@lrm/coforge-sdk/agent";
import { AgentMessageRequestError } from "./agent-message-request-error";
import { AgentTransportError } from "./agent-transport-error";
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
  decodeAgentActivityProbe,
  decodeAgentSkillsListRequest,
  encodeAgentSkillsListResult,
  AGENT_SKILLS_LIST_RESULT_METHOD,
  type AgentSkillsListRequest,
  type AgentSkillsListResult,
  type ComputerUpgradeResult,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
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
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_STATUS_METHOD,
  type DaemonRuntimeReadyRequest,
  type DaemonRuntimeCodeAgentsUpdateRequest,
  type DaemonRuntimeUsageScanRequest,
  type DaemonRuntimeUsageScanResponse,
  type AgentActivity,
  type AgentStatus,
  type AgentStartIntent,
  type AgentStopIntent,
  type AgentActivityProbe,
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
} from "@lrm/coforge-sdk/internal";
import { isAgentApiKey } from "../credentials/agent-api-key";
import type { AgentRuntimeProviderConfig } from "../code-agent/contract";
import { diagnosticErrorCode } from "../platform/diagnostic-error-code";
import { AgentWeeklyReportRequestError } from "./agent-weekly-report-request-error";
import { getLogger } from "@logtape/logtape";

export type AgentLaunchConfig = {
  agentApiKey: string;
  providerConfig?: AgentRuntimeProviderConfig;
  envVars?: Record<string, string>;
  assignedSkillPacks?: string[];
};

const AGENT_STATUS_REFRESH_MS = 30_000;
const COMPUTER_STATUS_REFRESH_MS = 30_000;
const RECONNECT_READY_RETRY_MS = 1_000;
const RECONNECT_READY_RETRY_MAX_MS = 60_000;
const REMEMBERED_REQUEST_IDS = 256;
const AGENT_RPC_TIMEOUT_MS = 10_000;
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
  sideEffectDecision?: "forward" | "hold" | "anyway_accepted" | "anyway_denied";
  holdToken?: string;
  anywayAllowed?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
  olderCursor?: string;
  newerCursor?: string;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  hasMore?: boolean;
  /** `send` only: pending messages bypassed via `continueAnyway`; empty otherwise. */
  recentUnread?: AgentMessage[];
};

/** Adapts the read route's response into the shape `DaemonRuntime` consumes. */
function adaptAgentHistoryResponse(response: AgentHistoryResponse): AgentMessageTransportResponse {
  return {
    protocolMajor: response.protocolMajor,
    requestId: response.requestId,
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
    requestId: response.requestId,
    accepted: true,
    attentionCount: 0,
    messages: response.results,
  };
}

/**
 * Adapts the send route's response into the shape `DaemonRuntime` consumes, mapping `state`/
 * `bypass` back onto `accepted`/`sideEffectDecision` losslessly: `sent` (no bypass) → `forward`,
 * `sent` with `bypass` → `anyway_accepted`, `held` → `hold`, `denied` → `anyway_denied`.
 */
function adaptAgentSendResponse(response: AgentSendResponse): AgentMessageTransportResponse {
  const sideEffectDecision: AgentMessageTransportResponse["sideEffectDecision"] =
    response.state === "sent"
      ? response.bypass
        ? "anyway_accepted"
        : "forward"
      : response.state === "held"
        ? "hold"
        : "anyway_denied";
  return {
    protocolMajor: response.protocolMajor,
    requestId: response.requestId,
    accepted: response.state === "sent",
    attentionCount: response.context.length,
    messageId: response.messageId,
    messages: response.context,
    sideEffectDecision,
    holdToken: response.holdToken,
    anywayAllowed: response.anywayAllowed,
    freshnessContextMode: response.freshnessContextMode,
    withheldMessageCount: response.withheldMessageCount,
    recentUnread: response.recentUnread,
  };
}

/** Adapts the resolve route's response into the shape `DaemonRuntime` consumes. */
function adaptAgentResolveResponse(response: AgentResolveResponse): AgentMessageTransportResponse {
  return {
    protocolMajor: response.protocolMajor,
    requestId: response.requestId,
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
    requestId: response.requestId,
    accepted: true,
    attentionCount: 0,
    messageId: response.messageId,
    messages: [],
  };
}
export interface AgentTaskHttpClient {
  execute(input: AgentHttpInput<TaskRequest>): Promise<TaskResponse>;
}
export interface AgentActionPrepareHttpClient {
  execute(input: AgentHttpInput<AgentActionPrepareRequest>): Promise<AgentActionPrepareResponse>;
}
export interface AgentWeeklyReportHttpClient {
  request(input: AgentHttpInput<WeeklyReportRequest>): Promise<WeeklyReportResponse>;
}

type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Provider-neutral client contract for the daemon's Workspace connection. */
export interface DaemonConnectionClient {
  workspaceInfo?(
    request: WorkspaceInfoRequest,
    agentApiKey?: string,
  ): Promise<WorkspaceInfoResponse>;
  githubCredential?(
    request: GitHubCredentialRequest,
    agentApiKey?: string,
  ): Promise<GitHubCredentialResponse>;
  onAgentWorkspaceReset?(callback: (request: AgentWorkspaceResetRequest) => void): () => void;
  sendAgentControlResult?(result: AgentControlResult): Promise<void>;
  start(token: string, config: DaemonConnectionConfig): Promise<void>;
  ready(createRequest: () => DaemonRuntimeReadyRequest): Promise<void>;
  updateCodeAgents?(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void>;
  onSkillsList?(callback: (request: AgentSkillsListRequest) => Promise<void>): () => void;
  sendSkillsListResult?(result: AgentSkillsListResult): Promise<void>;
  onUsageScan?(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void;
  sendUsageScanResult?(response: DaemonRuntimeUsageScanResponse): Promise<void>;
  sendUpgradeResult?(result: ComputerUpgradeResult): Promise<boolean>;
  stop(): Promise<void>;
  onReconnect?(callback: () => void): () => void;
  onAgentStart?(callback: (intent: AgentStartIntent) => void): () => void;
  onAgentStop?(callback: (intent: AgentStopIntent) => void): () => void;
  onAgentActivityProbe?(callback: (probe: AgentActivityProbe) => void): () => void;
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
  ): Promise<AgentMessageTransportResponse>;
  agentTask?(request: TaskRequest, agentApiKey?: string): Promise<TaskResponse>;
  agentActionPrepare?(
    request: AgentActionPrepareRequest,
    agentApiKey?: string,
  ): Promise<AgentActionPrepareResponse>;
  agentWeeklyReport?(
    request: WeeklyReportRequest,
    agentApiKey?: string,
  ): Promise<WeeklyReportResponse>;
  agentAttachment?(attachmentId: string, agentApiKey?: string): Promise<Response>;
  agentAttachmentUpload?(request: Request, agentApiKey?: string): Promise<Response>;
  agentAttachmentUploadSessionCreate?(body: unknown, agentApiKey?: string): Promise<Response>;
  agentAttachmentUploadSessionComplete?(uploadId: string, agentApiKey?: string): Promise<Response>;
  agentAttachmentUploadSessionCancel?(uploadId: string, agentApiKey?: string): Promise<Response>;
  agentAttachmentUploadSessionGet?(uploadId: string, agentApiKey?: string): Promise<Response>;
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
  throw AgentMessageRequestError.fromRpc(
    response.status,
    await readAgentResponseText(response, what),
  );
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

const AGENT_SEND_STATES = new Set(["sent", "held", "denied"]);

/** Validates the send route's response shape; the incident this module exists to prevent. */
function validateAgentSendResponseShape(data: unknown): string | undefined {
  if (!isRecord(data)) return "response body is not a JSON object";
  if (typeof data.state !== "string" || !AGENT_SEND_STATES.has(data.state))
    return `response state is not one of "sent"/"held"/"denied" (got ${JSON.stringify(data.state)})`;
  if (!Array.isArray(data.context)) return "response is missing the context array";
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
        requestId: request.requestId,
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
        requestId: request.requestId,
        query: request.query,
        target: request.target,
        sender: request.sender,
        sort: request.sort,
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
        body: JSON.stringify({
          requestId: request.requestId,
          target: request.target,
          body: request.body,
          holdToken: request.holdToken,
          continueAnyway: request.continueAnyway,
          seenUpToSequence: request.seenUpToSequence,
          freshnessContextMode: request.freshnessContextMode,
          attachmentId: request.attachmentId,
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
      query: { requestId: request.requestId, limit: request.limit },
      validate: validateAgentMessageArrayShape("events"),
    }),
  async requestChannelMute({ url, request, ...keys }) {
    const response = await fetchAgentResponse(
      httpClient,
      url,
      {
        method: "POST",
        headers: agentHeaders(keys, true),
        body: JSON.stringify({ requestId: request.requestId }),
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
        body: JSON.stringify({ requestId: request.requestId }),
      },
      "agent thread attention",
    );
    await assertAgentResponseOk(response, "agent thread attention");
    return readAgentResponseJson<AgentThreadAttentionResponse>(response, "agent thread attention");
  },
  async requestResolve({ url, request, ...keys }) {
    const endpoint = new URL(url);
    endpoint.searchParams.set("requestId", request.requestId);
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
        body: JSON.stringify({ requestId: request.requestId, emoji: request.emoji }),
      },
      "agent reaction",
    );
    await assertAgentResponseOk(response, "agent reaction");
    return readAgentResponseJson<AgentReactionResponse>(response, "agent reaction");
  },
  async requestWorkspaceInfo({ request, ...keys }) {
    const data = await getAgentJson<Omit<WorkspaceInfoResponse, "protocolMajor" | "requestId">>(
      httpClient,
      { ...keys, what: "workspace_info", query: {} },
    );
    return { ...data, protocolMajor: request.protocolMajor, requestId: request.requestId };
  },
  async requestGitHubCredential({ url, request, ...keys }) {
    const response = await httpClient(url, {
      method: "POST",
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub credential request failed (${response.status})`);
    return decodeGitHubCredentialResponse(await response.json());
  },
  async requestReminder({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await httpClient(url, {
        method: "POST",
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Agent reminder request failed");
    }
    if (!response.ok) throw new Error(`Agent reminder request failed (${response.status})`);
    let envelope: AgentReminderOperationResponse;
    try {
      envelope = (await response.json()) as AgentReminderOperationResponse;
    } catch {
      throw new Error("Agent reminder response is malformed");
    }
    if (!envelope || typeof envelope.requestId !== "string")
      throw new Error("Agent reminder response is malformed");
    return envelope;
  },
});

export const defaultAgentMessageHttpClient = createAgentMessageHttpClient();

export const defaultAgentWeeklyReportHttpClient: AgentWeeklyReportHttpClient = {
  async request({ url, request, ...keys }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
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
    if (result.requestId !== request.requestId)
      throw new Error("weekly-report response request ID does not match request");
    return result;
  },
};

export const defaultAgentTaskHttpClient: AgentTaskHttpClient = {
  async execute({ url, request, ...keys }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`server Agent Task request failed (${response.status})`);
    const result = (await response.json()) as TaskResponse;
    if (result.requestId !== request.requestId)
      throw new Error("Task response request ID does not match request");
    return result;
  },
};

export const defaultAgentActionPrepareHttpClient: AgentActionPrepareHttpClient = {
  async execute({ url, request, ...keys }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
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
  readonly #agentWorkspaceReset = new ListenerSlot<(request: AgentWorkspaceResetRequest) => void>();
  readonly #agentMessage = new ListenerSlot<(message: AgentMessageDelivery) => void>();
  readonly #reminderSync = new ListenerSlot<(sync: ReminderSync) => void>();
  readonly #skillsList = new ListenerSlot<(request: AgentSkillsListRequest) => Promise<void>>();
  readonly #usageScan = new ListenerSlot<
    (request: DaemonRuntimeUsageScanRequest) => Promise<void>
  >();
  readonly #reconnect = new ListenerSlot<() => void>();
  /** Publications received between a ready request and its acknowledgement, in arrival order. */
  #readyPublications: Array<() => void> | undefined;
  #readyRequestFactory: (() => DaemonRuntimeReadyRequest) | undefined;
  #readyRecoveryClient: CentrifugeWorkspaceClient | undefined;
  #readyRetryTimer: unknown;
  #readyRetryAttempts = 0;
  readonly #pendingActivity = new Map<string, AgentActivity>();
  readonly #supersededActivityLaunches = new Map<string, Set<string>>();
  readonly #latestStatuses = new Map<string, AgentStatus>();
  readonly #restartRequestIds = new Set<string>();
  readonly #upgradeRequestIds = new Set<string>();
  readonly #reportedUpgradeRequestIds = new Set<string>();
  #statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  #computerStatusRefreshTimer: unknown;
  #statusRpcQueue = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly clientFactory: CentrifugeWorkspaceClientFactory = defaultCentrifugeWorkspaceClientFactory,
    private readonly agentMessageHttpClient: AgentMessageHttpClient = defaultAgentMessageHttpClient,
    private readonly timing: DaemonConnectionTiming = defaultDaemonConnectionTiming,
    private readonly agentTaskHttpClient: AgentTaskHttpClient = defaultAgentTaskHttpClient,
    private readonly agentWeeklyReportHttpClient: AgentWeeklyReportHttpClient = defaultAgentWeeklyReportHttpClient,
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
        logger.info("Daemon cloud connection established", {
          event: "daemon_connection:connected",
          ...scope,
          control_stream_binding: "connect_proxy",
          outcome: "ok",
        });
        this.#reportOnline(client, config);
        this.#flushPendingActivity(client);
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

  onUsageScan(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void {
    return this.#usageScan.set(callback);
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

  sendAgentStatus(status: AgentStatus): void {
    this.#latestStatuses.set(status.agentId, status);
    if (this.#connected && this.#client) this.#queueAgentStatus(this.#client, status);
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

  /** Credentials for one Agent-scoped HTTP call; the daemon key stands in when no Agent key is given. */
  #agentKeys(agentApiKey: string | undefined) {
    return { agentApiKey: agentApiKey ?? this.#token, daemonApiKey: this.#token };
  }

  async agentMessage(
    request: AgentMessageRequest,
    agentApiKey?: string,
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
        requestId: events.requestId,
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
        requestId: result.requestId,
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
        requestId: result.requestId,
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
    agentApiKey?: string,
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

  async githubCredential(request: GitHubCredentialRequest, agentApiKey?: string) {
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

  async agentTask(request: TaskRequest, agentApiKey?: string): Promise<TaskResponse> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return this.agentTaskHttpClient.execute({
      url: this.#serverEndpoint("Agent Task HTTP", agentApiRoutes.cloud.tasks.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentActionPrepare(
    request: AgentActionPrepareRequest,
    agentApiKey?: string,
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
    agentApiKey?: string,
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

  async agentAttachment(attachmentId: string, agentApiKey?: string): Promise<Response> {
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
  async agentAttachmentUpload(request: Request, agentApiKey?: string): Promise<Response> {
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
   * The direct-upload session routes (ADR 0028) are plain JSON, unlike the multipart upload
   * above; each simply forwards its body (if any) to the matching cloud route with the same
   * Agent-scoped headers `agentAttachment`/`agentAttachmentUpload` already add.
   */
  async agentAttachmentUploadSessionCreate(body: unknown, agentApiKey?: string): Promise<Response> {
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
    agentApiKey?: string,
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
    agentApiKey?: string,
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

  async agentAttachmentUploadSessionGet(uploadId: string, agentApiKey?: string): Promise<Response> {
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
    };
    const providerConfig = parseAgentRuntimeProviderConfig(value.providerConfig);
    const assignedSkillPacks = Array.isArray(value.assignedSkillPacks)
      ? value.assignedSkillPacks.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      agentApiKey: parseAgentApiKey(value.apiKey),
      ...(providerConfig ? { providerConfig } : {}),
      envVars: parseAgentEnvironment(value.envVars),
      ...(assignedSkillPacks.length > 0 ? { assignedSkillPacks } : {}),
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
      this.#route(data, decodeDaemonRuntimeUsageScanRequest, (usage) => {
        if (usage.protocolMajor !== 1 || usage.workspaceId !== workspaceId || !usage.computerId)
          return false;
        void this.#usageScan.current?.(usage);
        return true;
      }) ||
      this.#route(data, decodeAgentActivityProbe, (probe) => {
        if (probe.protocolMajor !== 1 || !ownsDaemon(probe)) return false;
        this.#deliver(this.#agentActivityProbe, probe);
        return true;
      });
    if (handled) return;
    // Agent publications are the common case and must decode as exactly one intent kind.
    const decoders = [
      () =>
        this.#deliver(
          this.#agentMessage,
          this.#ownedIntent(decodeAgentMessageDelivery(data), workspaceId),
        ),
      () =>
        this.#deliver(this.#agentStop, this.#ownedIntent(decodeAgentStopIntent(data), workspaceId)),
      () =>
        this.#deliver(
          this.#agentStart,
          this.#ownedIntent(decodeAgentStartIntent(data), workspaceId),
        ),
    ];
    let rejection: unknown;
    for (const decode of decoders) {
      try {
        decode();
        return;
      } catch (error) {
        rejection = error;
      }
    }
    // Invalid publications are rejected at the protocol boundary and never reach the runtime.
    logger.warning("Rejected invalid Daemon control publication", {
      event: "daemon_control:rejected",
      workspace_id: workspaceId,
      computer_id: computerId,
      payload_bytes: data.byteLength,
      error_code: diagnosticErrorCode(rejection),
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
      logger.warning("Daemon reconnect recovery will retry", {
        event: "daemon_ready:retry_scheduled",
        request_id: request.requestId,
        workspace_id: request.workspaceId,
        computer_id: request.computerId,
        error_code: diagnosticErrorCode(error),
        retry_delay_ms: delayMs,
        attempt: this.#readyRetryAttempts,
      });
      this.#readyRetryTimer = this.timing.schedule(() => {
        this.#readyRetryTimer = undefined;
        void this.#attemptReadyRecovery(client, createRequest);
      }, delayMs);
      return;
    }
    if (!recovering()) return;
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
    ])
      collection.clear();
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
