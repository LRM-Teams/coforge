import type {
  AgentHistoryResponse,
  AgentSearchResponse,
  AgentSendResponse,
  AgentResolveResponse,
  AgentReactionResponse,
  AgentMessage,
  AgentEventsResponse,
  AgentChannelAttentionResponse,
  AgentThreadAttentionResponse,
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
  AgentUserInfoRequest,
  AgentUserInfoResponse,
  AgentUserInfoErrorCode,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentProfileErrorCode,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
  AgentMentionPendingResponse,
} from "@lrm/coforge-sdk/agent";
import {
  decodeGitHubCredentialResponse,
  decodeGitHubCommitTrailersResponse,
} from "@lrm/coforge-sdk/agent";
import type {
  TaskRequest,
  TaskResponse,
  WeeklyReportRequest,
  WeeklyReportResponse,
  ChannelCommand,
  AgentMessageRequest,
  WorkspaceInfoRequest,
  WorkspaceInfoResponse,
  AgentReminderOperationRequest,
  AgentReminderOperationResponse,
} from "@lrm/coforge-sdk/internal";
import { AgentTransportError } from "./agent-transport-error";
import { AgentUserInfoRequestError } from "./agent-user-info-request-error";
import { AgentProfileRequestError } from "./agent-profile-request-error";
import { AgentWeeklyReportRequestError } from "./agent-weekly-report-request-error";
import { AgentUpstreamRefusalError } from "./agent-upstream-refusal-error";
import {
  AGENT_RPC_TIMEOUT_MS,
  agentHeaders,
  agentWireBody,
  assertAgentResponseOk,
  fetchAgentResponse,
  getAgentEnvelopeJson,
  getAgentJson,
  getAgentManualJson,
  isRecord,
  mentionActionError,
  postAgentEnvelopeJson,
  readAgentResponseJson,
  readUpstreamErrorCode,
  validateAgentMessageArrayShape,
  validateAgentSendResponseShape,
  type AgentHttpInput,
  type HttpFetch,
} from "./agent-http-wire";

/** Agent HTTPS clients: contracts, response adapters, and default implementations.
 * Moved verbatim from `daemon-connection.ts`: no behaviour change, only a home. */
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
export function adaptAgentHistoryResponse(
  response: AgentHistoryResponse,
): AgentMessageTransportResponse {
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
export function adaptAgentSearchResponse(
  response: AgentSearchResponse,
): AgentMessageTransportResponse {
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
export function adaptAgentSendResponse(response: AgentSendResponse): AgentMessageTransportResponse {
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
export function adaptAgentResolveResponse(
  response: AgentResolveResponse,
): AgentMessageTransportResponse {
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
export function adaptAgentReactionResponse(
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
