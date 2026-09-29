import {
  AGENT_SEND_LOCAL_DEADLINE_MS,
  type AgentProxyFailureBody,
  decodeAgentMessageResponse,
  decodeAgentReminderOperationResponse,
  decodeLocalReminderRequest,
  encodeAgentReminderOperationResponse,
  encodeLocalReminderRequest,
  type AgentReminderOperationResponse,
  type ChannelCommand,
  type LocalReminderRequest,
  type MentionSelectorInput as MentionSelector,
  type TaskCommand,
  type TaskResult,
  type WorkspaceInfoResponse,
  type WeeklyReportCommand,
  type WeeklyReportResponse,
} from "@lrm/coforge-sdk/internal";
import type {
  ActionPrepareResult,
  LocalReminderReceiptResponse,
  ReminderTransportRequest,
} from "../index";
import {
  agentApiRoutes,
  decodeAgentApiRefusal,
  decodeAgentChannelErrorResponse,
  decodeAgentManualErrorResponse,
  decodeAgentManualGetResponse,
  decodeAgentManualSearchResponse,
  decodeAgentVersionResponse,
  decodeAgentProfileErrorResponse,
  decodeAgentProfileShowResponse,
  decodeAgentProfileUpdateResponse,
  decodeAgentUserInfoErrorResponse,
  decodeAgentUserInfoResponse,
  decodeGitHubCredentialResponse,
  decodeGitHubCommitTrailersResponse,
  decodeAgentMentionActionErrorResponse,
  decodeAgentMentionExecuteResponse,
  decodeAgentMentionPendingResponse,
  decodeAgentMentionDeliveryErrorResponse,
  decodeAgentMentionDeliveryResponse,
  type ActionCardAction,
  type AgentMentionDeliveryResponse,
  type AgentMentionExecuteRequest,
  type AgentMentionExecuteResponse,
  type AgentMentionPendingResponse,
  type AgentManualGetResponse,
  type AgentManualSearchResponse,
  type AgentVersionResponse,
  type AgentProfileShowResponse,
  type AgentProfileUpdateRequest,
  type AgentProfileUpdateResponse,
  type AgentUserInfoResponse,
} from "@lrm/coforge-sdk/agent";
import {
  CliError,
  MANUAL_NOT_FOUND_NEXT_ACTION,
  NO_MESSAGE_SENT_NEXT_ACTION,
  unknownDeliveryNextAction,
} from "./cli-error";
import { refusalNextAction } from "./refusal-guidance";

/** The local daemon proxy's JSON error contract (`AgentProxyFailureBody` in the SDK). A few proxy
 * refusals decided before a request is parsed (`unauthorized`, `not found`, `bad request`, …) are
 * bare text instead; `readProxyErrorBody` reads those as no body at all, so none is ever relayed. */
type AgentProxyErrorBody = Partial<Omit<AgentProxyFailureBody, "proxy">> & {
  proxy?: Partial<AgentProxyFailureBody["proxy"]>;
};

/** Reads a non-ok proxy response body once, as the JSON error contract when it is one. */
async function readProxyErrorBody(response: Response): Promise<{ json?: AgentProxyErrorBody }> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && ("code" in parsed || "proxy" in parsed))
      return { json: parsed as AgentProxyErrorBody };
  } catch {
    // A bare-text proxy refusal (unauthorized, not found, ...): no body to relay.
  }
  return {};
}

function operationFailedCode(operation: string): string {
  return `${operation.toUpperCase().replace(/-/g, "_")}_FAILED`;
}

/** The deadline of every local proxy call but a message send (`AGENT_SEND_LOCAL_DEADLINE_MS`). */
const OPERATION_DEADLINE_MS = 10_000;

/** The agent-context token grammar the proxy checks before issuing any request. */
const PROXY_CONTEXT_PATTERN = /^sfp_[A-Za-z0-9_-]{43}$/;

/** A local condition that meant no request was ever issued: nothing to wait on or undo. */
function preIssuanceError(operation: string, message: string): CliError {
  const isSend = operation === "send";
  return new CliError({
    code: isSend ? "SEND_PRECONDITION_FAILED" : operationFailedCode(operation),
    message,
    retryable: false,
    ...(isSend ? { draftSaved: false, suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION } : {}),
  });
}
/** The preflight every proxied request runs before it issues: the context must exist and match
 * the token grammar, and a proxy must be configured. Raises the operation's own pre-issuance
 * error, so no request is ever sent on a missing setup. */
function requireProxySetup(operation: string, context: string, proxyUrl: string): void {
  if (!context) throw preIssuanceError(operation, "coforge agent context is not configured");
  if (!PROXY_CONTEXT_PATTERN.test(context))
    throw preIssuanceError(operation, "coforge agent context is invalid");
  if (!proxyUrl) throw preIssuanceError(operation, "coforge agent proxy is not configured");
}

/**
 * Classifies a non-ok proxy response (or a network failure reaching the proxy) into a `CliError`.
 * `send` failures raised here happened AFTER the daemon saved the local draft and handed the
 * request to its transport (see `runtime.ts#sendAgentMessage`): delivery state is unknown, so they
 * are not retryable from this evidence alone (Raft-aligned; see `cli-error.ts`) — unless the daemon
 * says otherwise: after a failed same-key replay it knows whether the draft still holds the key.
 */
function proxyHttpFailure(
  operation: string,
  status: number,
  body: { json?: AgentProxyErrorBody },
  target: string | undefined,
): CliError {
  const isSend = operation === "send";
  const proxy = body.json?.proxy;
  const isLocalPrecondition = proxy?.failure_class === "local_precondition";
  // A server refusal names its own next step (`refusal-guidance.ts`).
  const refusalNext =
    proxy?.failure_class === "upstream_refusal"
      ? refusalNextAction(
          operation,
          {
            status: proxy.upstream_status ?? status,
            code: body.json?.code,
            retryable: body.json?.retryable,
          },
          target ?? "",
        )
      : undefined;
  // A local precondition usually means nothing was saved, but a guard that saves a draft before
  // refusing (e.g. --target-confirmed) says so explicitly via `draft_saved`; honour it when present.
  const draftSaved = proxy?.draft_saved !== undefined ? proxy.draft_saved : !isLocalPrecondition;
  const message = body.json?.error || `HTTP ${status}`;
  const code = failureCode(operation, status, body.json);
  return new CliError({
    code,
    message,
    retryable: body.json?.retryable ?? false,
    ...(isSend ? { draftSaved } : {}),
    correlationId: proxy?.correlation_id,
    proxy: proxy
      ? {
          failureClass: proxy.failure_class,
          causeCode: proxy.cause_code,
          routeFamily: proxy.route_family,
          upstreamLayer: proxy.upstream_layer,
          upstreamStatus: proxy.upstream_status,
          responseStarted: proxy.response_started,
          responseComplete: proxy.response_complete,
        }
      : { upstreamStatus: status },
    // The daemon names the next step when it knows better than the generic line: a precondition
    // with its own remedy, or a failed same-key replay whose draft may or may not be retried. A
    // server refusal names its own.
    suggestedNextAction:
      body.json?.suggested_next_action ??
      refusalNext ??
      (isSend
        ? isLocalPrecondition
          ? NO_MESSAGE_SENT_NEXT_ACTION
          : unknownDeliveryNextAction(target ?? "")
        : undefined),
    ...(body.json?.details ? { details: body.json.details } : {}),
  });
}

/**
 * The typed code an Agent decides on. It follows the proxy's `failure_class`, not the proxy's own
 * HTTP status: a decode failure after an upstream 200 is `INVALID_JSON_RESPONSE` (Raft's code for
 * it), never `SERVER_5XX`, which is reserved for an upstream that really answered 5xx.
 */
function failureCode(operation: string, status: number, json: AgentProxyErrorBody | undefined) {
  const proxy = json?.proxy;
  switch (proxy?.failure_class) {
    case "local_precondition":
      return json?.code ?? operationFailedCode(operation);
    case "protocol_mismatch":
      return "INVALID_JSON_RESPONSE";
    // The server's own stable code when its refusal named one (`DM_PEER_NOT_IN_WORKSPACE`).
    case "upstream_refusal":
      return json?.code ?? operationFailedCode(operation);
    case "upstream_http_response":
      return (proxy?.upstream_status ?? status) >= 500
        ? "SERVER_5XX"
        : operationFailedCode(operation);
    case "pre_response_transport":
    case "mid_response_transport":
      return operationFailedCode(operation);
    default:
      return status >= 500 ? "SERVER_5XX" : operationFailedCode(operation);
  }
}

/** A failure reaching the local daemon proxy itself (network/timeout): treated conservatively as
 * "may have been issued" — see `unknownDeliveryNextAction`. */
function proxyTransportFailure(operation: string, target: string | undefined): CliError {
  const isSend = operation === "send";
  return new CliError({
    code: isSend ? "SEND_FAILED" : operationFailedCode(operation),
    message: "agent proxy request failed (network or timeout)",
    retryable: false,
    ...(isSend
      ? { draftSaved: true, suggestedNextAction: unknownDeliveryNextAction(target ?? "") }
      : {}),
  });
}

function manualFailedCode(errorCode: string | undefined): string {
  return errorCode ? errorCode.toUpperCase() : "MANUAL_FAILED";
}

/**
 * GETs one of the two Agent Manual routes through the local daemon proxy. Unlike
 * `call` above (the multiplexed `messages` operation), the Manual routes always answer a domain
 * error as JSON `{ ok: false, errorCode, error }`, so that `errorCode` becomes the `CliError`
 * code directly, and a `knowledge_not_found` gets the Raft-aligned "browse the index" guidance.
 */
async function manualRequest<T>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  path: string,
  query: Record<string, string>,
  decode: (value: unknown) => T,
): Promise<T> {
  requireProxySetup("manual", context, proxyUrl);
  const endpoint = proxyEndpoint(path);
  for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "MANUAL_FAILED",
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  }
  const rawBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorBody = decodeAgentManualErrorResponse(rawBody);
    throw new CliError({
      code: manualFailedCode(errorBody?.errorCode),
      message: errorBody?.error ?? `HTTP ${response.status}`,
      retryable: false,
      suggestedNextAction:
        errorBody?.errorCode === "knowledge_not_found" ? MANUAL_NOT_FOUND_NEXT_ACTION : undefined,
    });
  }
  return decode(rawBody);
}

/**
 * GETs the local-only `/api/agent/v1/version` route: unlike
 * `manualRequest` above, this never reaches Web/backend, so a non-ok response is always a local
 * proxy/daemon condition, never a domain error envelope. A network/timeout failure is reported as
 * "the live daemon could not be queried", matching `coforge version`'s own refusal wording for a
 * daemon that never answered.
 */
async function versionRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
): Promise<AgentVersionResponse> {
  requireProxySetup("version", context, proxyUrl);
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(agentApiRoutes.proxy.version.path), {
      method: agentApiRoutes.proxy.version.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "VERSION_FAILED",
      message:
        "The live daemon could not be queried: agent proxy request failed (network or timeout).",
      retryable: false,
    });
  }
  if (!response.ok) {
    const errorBody = await readProxyErrorBody(response);
    throw proxyHttpFailure("version", response.status, errorBody, undefined);
  }
  return decodeAgentVersionResponse(await response.json().catch(() => undefined));
}

/**
 * GETs a route that always answers a domain error as JSON `{ ok: false, errorCode, error }`
 * (same convention as `manualRequest` above, generalized so `user info`/`profile show` do not
 * duplicate it): `errorCode` becomes the `CliError` code directly.
 */
async function envelopeGetRequest<T>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  path: string,
  query: Record<string, string>,
  decode: (value: unknown) => T,
  decodeError: (value: unknown) => { errorCode: string; error: string } | undefined,
  operation: string,
): Promise<T> {
  requireProxySetup(operation, context, proxyUrl);
  const endpoint = proxyEndpoint(path);
  for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: operationFailedCode(operation),
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  }
  const rawBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorBody = decodeError(rawBody);
    throw new CliError({
      code: errorBody?.errorCode
        ? errorBody.errorCode.toUpperCase()
        : operationFailedCode(operation),
      message: errorBody?.error ?? `HTTP ${response.status}`,
      retryable: false,
    });
  }
  return decode(rawBody);
}

/** Same envelope convention as `envelopeGetRequest`, for the one POST route (`profile update`). */
async function callProfileUpdate(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  input: AgentProfileUpdateRequest,
): Promise<AgentProfileUpdateResponse> {
  requireProxySetup("profile-update", context, proxyUrl);
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(agentApiRoutes.local.profile.update.path), {
      method: agentApiRoutes.local.profile.update.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "PROFILE_UPDATE_FAILED",
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  }
  const rawBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorBody = decodeAgentProfileErrorResponse(rawBody);
    throw new CliError({
      code: errorBody?.errorCode ? errorBody.errorCode.toUpperCase() : "PROFILE_UPDATE_FAILED",
      message: errorBody?.error ?? `HTTP ${response.status}`,
      retryable: false,
    });
  }
  return decodeAgentProfileUpdateResponse(rawBody);
}

/**
 * One mention action route through the local Proxy. A 5xx is `SERVER_5XX`; any other refusal is
 * `<OPERATION>_FAILED` carrying the server's own error text (the `{ ok: false, errorCode, error }`
 * envelope, the Proxy's JSON error, or its bare text).
 */
async function mentionActionRequest<T>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  operation: "mention-pending" | "mention-action",
  route: { method: string; path: string },
  body: AgentMentionExecuteRequest | undefined,
  decode: (value: unknown) => T,
): Promise<T> {
  requireProxySetup(operation, context, proxyUrl);
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(route.path), {
      method: route.method,
      headers: {
        authorization: `Bearer ${context}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: operationFailedCode(operation),
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      const parsed: unknown = JSON.parse(text);
      const envelope = decodeAgentMentionActionErrorResponse(parsed);
      const proxyError = (parsed as { error?: unknown } | null)?.error;
      message = envelope?.error ?? (typeof proxyError === "string" ? proxyError : text);
    } catch {
      // A bare-text Proxy error (e.g. "bad request"): its text is the message.
    }
    throw new CliError({
      code: response.status >= 500 ? "SERVER_5XX" : operationFailedCode(operation),
      message: message || `HTTP ${response.status}`,
      retryable: false,
    });
  }
  return decode(await response.json().catch(() => undefined));
}

/** A mention delivery failure that is not the server's own answer; `MENTION_DELIVERY_FAILED` is
 * already the code of a send whose @mentions reached no one. */
const MENTION_DELIVERY_LOOKUP_FAILED = "MENTION_DELIVERY_LOOKUP_FAILED";

/**
 * Mention delivery through the local Proxy. The server's own answers keep their code
 * (`MESSAGE_NOT_FOUND`, `AMBIGUOUS_MESSAGE_ID`); a 5xx is `SERVER_5XX`, and any other refusal is
 * `MENTION_DELIVERY_LOOKUP_FAILED` with the Proxy's text. The lookup is a read, so a network
 * failure or a 5xx is retryable.
 */
async function mentionDeliveryRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  messageId: string,
): Promise<AgentMentionDeliveryResponse> {
  requireProxySetup("mention-delivery", context, proxyUrl);
  const route = agentApiRoutes.local.mentionDeliveries;
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(route.path(messageId)), {
      method: route.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(OPERATION_DEADLINE_MS),
    });
  } catch {
    throw new CliError({
      code: MENTION_DELIVERY_LOOKUP_FAILED,
      message: "agent proxy request failed (network or timeout)",
      retryable: true,
    });
  }
  if (response.ok) return decodeAgentMentionDeliveryResponse(await response.json());
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A bare-text Proxy error (e.g. "bad request"): its text is the message.
  }
  const envelope = decodeAgentMentionDeliveryErrorResponse(parsed);
  const proxyError = (parsed as { error?: unknown } | undefined)?.error;
  const serverFailure = response.status >= 500;
  throw new CliError({
    code: envelope
      ? envelope.errorCode.toUpperCase()
      : serverFailure
        ? "SERVER_5XX"
        : MENTION_DELIVERY_LOOKUP_FAILED,
    message:
      (envelope?.error ?? (typeof proxyError === "string" ? proxyError : text)) ||
      `HTTP ${response.status}`,
    retryable: !envelope && serverFailure,
  });
}

export function connectLocal(
  _socketPath: string,
  context: string,
  proxyUrl = Bun.env.COFORGE_AGENT_PROXY_URL ?? "",
) {
  const proxyEndpoint = (path: string) => {
    const endpoint = new URL(proxyUrl);
    endpoint.pathname = path;
    endpoint.search = "";
    return endpoint;
  };
  const call = async (
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
      | "unreact",
    target?: string,
    body?: string,
    options?: {
      sendDraft?: boolean;
      expectedDraftKey?: string;
      continueAnyway?: boolean;
      freshnessContextMode?: "withheld";
      before?: string;
      after?: string;
      around?: string;
      limit?: number;
      query?: string;
      sender?: string;
      sort?: "relevance" | "recent";
      offset?: number;
      messageId?: string;
      emoji?: string;
      attachmentIds?: string[];
      mentions?: MentionSelector[];
      targetConfirmed?: boolean;
    },
  ) => {
    if (!context) throw preIssuanceError(operation, "coforge agent context is not configured");
    if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw preIssuanceError(operation, "coforge agent context is invalid");
    const idempotencyKey = crypto.randomUUID();
    if (!proxyUrl) throw preIssuanceError(operation, "coforge agent proxy is not configured");
    // One attempt, for `send` too: the daemon settles an ambiguous send by its key
    // (`reconcileOnly`) and replays it at most once, so a blind retry here could only add a guess.
    let response: Response;
    try {
      response = await fetch(proxyEndpoint(agentApiRoutes.proxy.messages.path), {
        method: agentApiRoutes.local.messages.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey, operation, target, content: body, ...options }),
        // A send waits out the daemon's whole settlement (send, reconciliation, replay), so its
        // verdict reaches the Agent; every other operation keeps the short deadline.
        signal: AbortSignal.timeout(
          operation === "send" ? AGENT_SEND_LOCAL_DEADLINE_MS : OPERATION_DEADLINE_MS,
        ),
      });
    } catch {
      throw proxyTransportFailure(operation, target);
    }
    if (!response.ok) {
      const errorBody = await readProxyErrorBody(response);
      const failure = proxyHttpFailure(operation, response.status, errorBody, target);
      if (
        options?.freshnessContextMode === "withheld" &&
        errorBody.json?.proxy?.failure_class !== "local_precondition"
      ) {
        const label = operation === "send" ? "send" : `${operation} request`;
        // Reviewer isolation redacts only what could carry upstream detail — the message, the code
        // and the proxy diagnostics. The daemon's verdict (retryable, draft saved, next action)
        // names only the key and target, so it stays (Raft's reviewer-isolation send failure).
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : operationFailedCode(operation),
          message: `Reviewer-isolation ${label} failed (HTTP ${response.status}); upstream error detail was withheld.`,
          retryable: failure.retryable,
          draftSaved: failure.draftSaved,
          correlationId: failure.correlationId,
          suggestedNextAction: failure.suggestedNextAction,
          details: failure.details,
          proxy: { upstreamStatus: response.status },
        });
      }
      throw failure;
    }
    return (await response.json()) as ReturnType<typeof decodeAgentMessageResponse>;
  };
  return {
    reminder: (request: ReminderTransportRequest) => callReminder(request),
    inboxCheck: () => callInbox(),
    setChannelMuted: (target: string, muted: boolean) => call(muted ? "mute" : "unmute", target),
    setThreadFollowed: (target: string, followed: boolean) => {
      if (followed) throw new Error("Explicit thread follow is unavailable");
      return call("thread-unfollow", target);
    },
    check: (target?: string) => call("check", target),
    read: (
      target: string,
      options?: { before?: string; after?: string; around?: string; limit?: number },
    ) => call("read", target, undefined, options),
    search: (options: import("../index").MessageSearchOptions) =>
      call("search", options.target, undefined, options),
    send: (
      target: string,
      body?: string,
      options?: {
        sendDraft?: boolean;
        expectedDraftKey?: string;
        continueAnyway?: boolean;
        freshnessContextMode?: "withheld";
        attachmentIds?: string[];
        mentions?: MentionSelector[];
        targetConfirmed?: boolean;
      },
    ) => call("send", target, body, options),
    resolve: (messageId: string) => call("resolve", undefined, undefined, { messageId }),
    react: (messageId: string, emoji: string, remove?: boolean) =>
      call(remove ? "unreact" : "react", undefined, undefined, { messageId, emoji }),
    task: (command: TaskCommand) => callTask(command),
    channel: (command: Omit<ChannelCommand, "idempotencyKey">) => callChannel(command),
    actionPrepare: (target: string, action: ActionCardAction) => callActionPrepare(target, action),
    workspaceInfo: async (): Promise<import("../index").WorkspaceInfoResult> => {
      if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
        throw new Error("coforge agent context is invalid");
      if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
      const response = await fetch(proxyEndpoint(agentApiRoutes.workspace.info.path), {
        method: agentApiRoutes.workspace.info.method,
        headers: { authorization: `Bearer ${context}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`workspace info request failed (${response.status})`);
      return (await response.json()) as WorkspaceInfoResponse;
    },
    weeklyReport: (command: WeeklyReportCommand) => callWeeklyReport(command),
    weeklyReportCollect: (command: import("../index").WeeklyReportCollectCommand) =>
      callWeeklyReportCollect(command),
    weeklyReportKeyPoints: (command: import("../index").WeeklyReportKeyPointsCommand) =>
      callWeeklyReportKeyPoints(command),
    githubCredential: async () => {
      if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
        throw new Error("coforge agent context is invalid");
      if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
      const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.githubCredentials.path), {
        method: agentApiRoutes.proxy.githubCredentials.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`GitHub credential request failed (${response.status})`);
      return decodeGitHubCredentialResponse(await response.json());
    },
    githubCommitTrailers: async (repository: string | null): Promise<string[]> => {
      if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
        throw new Error("coforge agent context is invalid");
      if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
      const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.githubCommitTrailers.path), {
        method: agentApiRoutes.proxy.githubCommitTrailers.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify({ repository }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`GitHub commit trailers request failed (${response.status})`);
      return decodeGitHubCommitTrailersResponse(await response.json()).trailers;
    },
    manualGet: (topic: string, intent: string, reason: string): Promise<AgentManualGetResponse> =>
      manualRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        agentApiRoutes.manual.get.path,
        { topic, intent, reason },
        decodeAgentManualGetResponse,
      ),
    manualSearch: (
      query: string,
      intent: string,
      reason: string,
    ): Promise<AgentManualSearchResponse> =>
      manualRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        agentApiRoutes.manual.search.path,
        { query, intent, reason },
        decodeAgentManualSearchResponse,
      ),
    version: (): Promise<AgentVersionResponse> => versionRequest(proxyEndpoint, context, proxyUrl),
    userInfo: (name: string): Promise<AgentUserInfoResponse> =>
      envelopeGetRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        agentApiRoutes.local.users.path(name),
        {},
        decodeAgentUserInfoResponse,
        decodeAgentUserInfoErrorResponse,
        "user-info",
      ),
    profileShow: (target?: string): Promise<AgentProfileShowResponse> =>
      envelopeGetRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        agentApiRoutes.local.profile.get.path,
        target ? { target } : {},
        decodeAgentProfileShowResponse,
        decodeAgentProfileErrorResponse,
        "profile-show",
      ),
    profileUpdate: (input: AgentProfileUpdateRequest): Promise<AgentProfileUpdateResponse> =>
      callProfileUpdate(proxyEndpoint, context, proxyUrl, input),
    mentionPending: (): Promise<AgentMentionPendingResponse> =>
      mentionActionRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        "mention-pending",
        agentApiRoutes.local.mentionActions.pending,
        undefined,
        decodeAgentMentionPendingResponse,
      ),
    mentionExecute: (request: AgentMentionExecuteRequest): Promise<AgentMentionExecuteResponse> =>
      mentionActionRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        "mention-action",
        agentApiRoutes.local.mentionActions.execute,
        request,
        decodeAgentMentionExecuteResponse,
      ),
    mentionDelivery: (messageId: string): Promise<AgentMentionDeliveryResponse> =>
      mentionDeliveryRequest(proxyEndpoint, context, proxyUrl, messageId),
    view: async (attachmentId: string) => {
      if (!context) throw new Error("coforge agent context is not configured");
      if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
        throw new Error("coforge agent context is invalid");
      if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
      const endpoint = new URL(proxyUrl);
      endpoint.pathname = agentApiRoutes.local.attachments.path(attachmentId);
      endpoint.search = "";
      const response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${context}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        // Mirrors Raft 1.0.32's attachmentViewCommand: VIEW_FAILED (SERVER_5XX for >= 500), with
        // a fixed message for a 404 rather than relaying upstream detail for a missing attachment.
        const text = await response.text().catch(() => "");
        let message = text;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed && typeof parsed.error === "string") message = parsed.error;
        } catch {
          // Not JSON: keep the raw text (e.g. a legacy bare-text proxy error).
        }
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : "VIEW_FAILED",
          message:
            response.status === 404
              ? "Attachment is unavailable."
              : message || `HTTP ${response.status}`,
          retryable: false,
        });
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        fileName: response.headers.get("content-disposition") ?? undefined,
      };
    },
    upload: (input: { path: string; target: string; mimeType?: string }) =>
      callAttachmentUpload(input),
  };

  /**
   * `null` means "no capability endpoint" (a 404, matching Raft 1.0.32's `attachmentUploadCommand`:
   * `capabilityResponse.status === 404` falls back rather than failing) — the caller skips its
   * client-side size check and disables direct upload, letting the server enforce its own limit
   * on the real upload.
   */
  async function callAttachmentCapabilities(): Promise<{
    maxBytes: number;
    directUploadEnabled: boolean;
    directUploadThresholdBytes: number;
  } | null> {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const endpoint = new URL(proxyUrl);
    // `capabilities` is a declared sub-route of the attachment route, served by Web ahead of the id
    // route. The request still rides the download forwarding (`agent-proxy.ts`), which treats any
    // segment after the attachment prefix as an opaque attachment id and reaches the identical
    // cloud URL — which is why this needs no route of its own in the Daemon. Covered by a
    // `local-client.test.ts` case; if a future daemon route-ordering change breaks it, add explicit
    // forwarding there.
    endpoint.pathname = agentApiRoutes.local.attachments.capabilities.path;
    endpoint.search = "";
    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${context}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CliError({
        code: "UPLOAD_CAPABILITY_FAILED",
        message: "attachment capabilities request failed (network or timeout)",
        retryable: false,
      });
    }
    if (response.status === 404) return null;
    if (!response.ok)
      throw new CliError({
        code: "UPLOAD_CAPABILITY_FAILED",
        message: `attachment capabilities request failed (${response.status})`,
        retryable: false,
      });
    return (await response.json()) as {
      maxBytes: number;
      directUploadEnabled: boolean;
      directUploadThresholdBytes: number;
    };
  }

  type AttachmentUploadResult = {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  };

  /**
   * The failure a non-ok upload answer reports. The upload routes pass the server's body through
   * unchanged, so only a 4xx in the Agent API's refusal shape is shown, with its code and next
   * step; anything else is its HTTP status alone.
   */
  async function attachmentFailure(response: Response, target: string): Promise<CliError> {
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: never relayed.
    }
    const refusal = response.status < 500 ? decodeAgentApiRefusal(parsed) : undefined;
    if (!refusal)
      return new CliError({
        code: response.status >= 500 ? "SERVER_5XX" : "UPLOAD_FAILED",
        message: `HTTP ${response.status}`,
        retryable: false,
      });
    return new CliError({
      code: refusal.code ?? "UPLOAD_FAILED",
      message: refusal.error,
      retryable: refusal.retryable === true,
      suggestedNextAction: refusalNextAction(
        "upload",
        { status: response.status, code: refusal.code, retryable: refusal.retryable },
        target,
      ),
    });
  }

  async function callAttachmentUpload(input: {
    path: string;
    target: string;
    mimeType?: string;
  }): Promise<AttachmentUploadResult> {
    if (!context) throw new Error("coforge agent context is not configured");
    if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const file = Bun.file(input.path);
    const sizeBytes = file.size;
    const capabilities = await callAttachmentCapabilities();
    if (capabilities && sizeBytes > capabilities.maxBytes)
      throw new CliError({
        code: "ATTACHMENT_TOO_LARGE",
        message: `File is ${sizeBytes} bytes; the server allows at most ${capabilities.maxBytes} bytes.`,
        retryable: false,
      });
    const fileName = input.path.split("/").pop() || "attachment";
    const contentType = input.mimeType || "application/octet-stream";
    if (capabilities?.directUploadEnabled && sizeBytes >= capabilities.directUploadThresholdBytes) {
      return callAttachmentDirectUpload({
        path: input.path,
        target: input.target,
        fileName,
        contentType,
        sizeBytes,
      });
    }
    return callAttachmentMultipartUpload({
      path: input.path,
      target: input.target,
      fileName,
      file,
    });

    async function callAttachmentMultipartUpload(multipart: {
      path: string;
      target: string;
      fileName: string;
      file: ReturnType<typeof Bun.file>;
    }): Promise<AttachmentUploadResult> {
      const form = new FormData();
      form.set(
        "file",
        new Blob([await multipart.file.arrayBuffer()], { type: input.mimeType }),
        multipart.fileName,
      );
      form.set("target", multipart.target);
      if (input.mimeType) form.set("mimeType", input.mimeType);
      const endpoint = new URL(proxyUrl!);
      endpoint.pathname = agentApiRoutes.local.attachments.upload.path;
      endpoint.search = "";
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: agentApiRoutes.local.attachments.upload.method,
          headers: { authorization: `Bearer ${context}` },
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new CliError({
          code: "UPLOAD_FAILED",
          message: "attachment upload request failed (network or timeout)",
          retryable: false,
        });
      }
      if (!response.ok) throw await attachmentFailure(response, multipart.target);
      return (await response.json()) as AttachmentUploadResult;
    }
  }

  /**
   * Direct (presigned) upload, run exactly as Raft 1.0.32's `attachmentUploadCommand`: create a
   * session, PUT the bytes straight to storage (one retry on network error / 408 / 429 / 5xx),
   * then complete with up to 3 retries on `UPLOAD_OBJECT_NOT_FOUND` /
   * `UPLOAD_VERIFICATION_IN_PROGRESS`. One deviation from Raft: this repo's storage (Alibaba
   * Cloud OSS) has no `If-None-Match` precondition, so "the object already exists" is OSS's own
   * `x-oss-forbid-overwrite` conflict status, `409`, not Raft's `412` (see
   * `oss-file-storage.server.ts`'s `presignPut` doc comment).
   */
  async function callAttachmentDirectUpload(input: {
    path: string;
    target: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<AttachmentUploadResult> {
    const endpoint = new URL(proxyUrl!);
    endpoint.pathname = agentApiRoutes.local.attachmentUploadSessions.create.path;
    endpoint.search = "";
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: agentApiRoutes.local.attachmentUploadSessions.create.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify({
          target: input.target,
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          idempotencyKey: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CliError({
        code: "UPLOAD_FAILED",
        message: "attachment upload session request failed (network or timeout)",
        retryable: false,
      });
    }
    if (!response.ok) throw await attachmentFailure(response, input.target);
    const created = (await response.json()) as {
      uploadId: string;
      upload: { url: string; headers: Record<string, string> };
    };

    const put = await putFileToPresignedUrl(input.path, created.upload.url, created.upload.headers);
    if (put.outcome === "failed" && put.definite) {
      await callAttachmentUploadSessionCancel(created.uploadId).catch(() => undefined);
      throw new CliError({
        code: "UPLOAD_OBJECT_PUT_FAILED",
        message: `direct object upload failed with HTTP ${put.status}`,
        retryable: false,
      });
    }
    // Every other outcome — uploaded, already-exists (a repeat of an idempotent create), or an
    // ambiguous network failure the server may still have received — falls through to the
    // server's own HEAD-based verification, exactly as Raft 1.0.32 does.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const completed = await callAttachmentUploadSessionComplete(created.uploadId, input.target);
      if (completed.ok) return completed.attachment;
      if (!completed.retryable || attempt === 2) throw completed.error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new CliError({
      code: "UPLOAD_FAILED",
      message: "direct upload completion ended without a terminal response",
      retryable: false,
    });
  }

  async function callAttachmentUploadSessionComplete(
    uploadId: string,
    target: string,
  ): Promise<
    | { ok: true; attachment: AttachmentUploadResult }
    | { ok: false; retryable: boolean; error: CliError }
  > {
    const endpoint = new URL(proxyUrl!);
    endpoint.pathname = agentApiRoutes.local.attachmentUploadSessions.complete.path(uploadId);
    endpoint.search = "";
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: agentApiRoutes.local.attachmentUploadSessions.complete.method,
        headers: { authorization: `Bearer ${context}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return {
        ok: false,
        retryable: false,
        error: new CliError({
          code: "UPLOAD_FAILED",
          message: "attachment upload completion request failed (network or timeout)",
          retryable: false,
        }),
      };
    }
    if (response.ok) {
      const body = (await response.json()) as { attachment: AttachmentUploadResult };
      return { ok: true, attachment: body.attachment };
    }
    const error = await attachmentFailure(response, target);
    return { ok: false, retryable: error.retryable === true, error };
  }

  async function callAttachmentUploadSessionCancel(uploadId: string): Promise<void> {
    const endpoint = new URL(proxyUrl!);
    endpoint.pathname = agentApiRoutes.local.attachmentUploadSessions.cancel.path(uploadId);
    endpoint.search = "";
    await fetch(endpoint, {
      method: agentApiRoutes.local.attachmentUploadSessions.cancel.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  }

  /**
   * PUTs the file straight to storage. Mirrors Raft 1.0.32's `putFileToPresignedUrl`: one retry
   * on a thrown network error or a `408`/`429`/`5xx` response; any other non-2xx is a definite
   * failure. `already_exists` is this repo's OSS `409` (see this function's caller's own doc
   * comment), not Raft's `412`.
   */
  async function putFileToPresignedUrl(
    path: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<
    | { outcome: "uploaded" | "already_exists"; definite: true }
    | { outcome: "failed"; definite: boolean; status?: number }
  > {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        // `Bun.file(path)` is a `Blob`; Bun knows its size up front, so `fetch` sets a real
        // `Content-Length` from it and streams the bytes from disk itself, with no
        // `Transfer-Encoding: chunked`. A `ReadableStream` body (`Bun.file(path).stream()`) has
        // no known length, so `fetch` sends it chunked instead — OSS's PutObject needs a real
        // `Content-Length`, and a manually-set one on a streamed body can be dropped or conflict
        // with the chunked encoding `fetch` chooses on its own (verified with a `Bun.serve`
        // fake in `local-client.test.ts`).
        response = await fetch(url, {
          method: "PUT",
          headers,
          body: Bun.file(path),
          redirect: "error",
        });
      } catch {
        if (attempt === 0) continue;
        return { outcome: "failed", definite: false };
      }
      if (response.ok) return { outcome: "uploaded", definite: true };
      if (response.status === 409) return { outcome: "already_exists", definite: true };
      const mayExist = response.status === 408 || response.status === 429 || response.status >= 500;
      if (mayExist && attempt === 0) continue;
      return { outcome: "failed", definite: !mayExist, status: response.status };
    }
    return { outcome: "failed", definite: false };
  }

  async function callInbox() {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.inbox.path), {
      method: agentApiRoutes.local.inbox.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), operation: "check" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`agent inbox request failed (${response.status})`);
    return response.json();
  }

  async function callReminder(
    fields: ReminderTransportRequest,
  ): Promise<AgentReminderOperationResponse | LocalReminderReceiptResponse> {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const idempotencyKey = crypto.randomUUID();
    const validated = decodeLocalReminderRequest(
      encodeLocalReminderRequest({ ...fields, idempotencyKey, context } as LocalReminderRequest),
    );
    const { context: _implicitContext, ...body } = validated;
    let response: Response;
    try {
      response = await fetch(proxyEndpoint(agentApiRoutes.proxy.reminders.path), {
        method: agentApiRoutes.local.reminders.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("agent reminder request failed (network or timeout)");
    }
    if (!response.ok) throw new Error(`agent reminder request failed (${response.status})`);
    const result = (await response.json()) as
      | AgentReminderOperationResponse
      | LocalReminderReceiptResponse;
    if (fields.operation === "ack" || fields.operation === "dismiss") return result;
    return decodeAgentReminderOperationResponse(
      encodeAgentReminderOperationResponse(result as AgentReminderOperationResponse),
    );
  }

  async function callTask(command: TaskCommand) {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    let response: Response;
    try {
      response = await fetch(proxyEndpoint(agentApiRoutes.proxy.tasks.path), {
        method: agentApiRoutes.local.tasks.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw proxyTransportFailure(command.operation, command.target);
    }
    if (!response.ok) {
      const errorBody = await readProxyErrorBody(response);
      if (command.freshnessContextMode === "withheld")
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : operationFailedCode(command.operation),
          message: `Reviewer-isolation task ${command.operation} failed (HTTP ${response.status}); upstream error detail was withheld.`,
          retryable: false,
          proxy: { upstreamStatus: response.status },
        });
      throw proxyHttpFailure(command.operation, response.status, errorBody, command.target);
    }
    return (await response.json()) as TaskResult;
  }

  async function callChannel(command: Omit<ChannelCommand, "idempotencyKey">) {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const idempotencyKey = crypto.randomUUID();
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.channels.path), {
      method: agentApiRoutes.local.channels.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify({ ...command, idempotencyKey }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const rawText = await response.text();
      // A JSON-enveloped `errorCode` (currently only `agent_not_visible`) is a real
      // wire field the CLI renders directly, checked ahead of every other rule below — its own
      // explanation must never be discarded in favor of a fixed "Channel not found" message.
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = undefined;
      }
      const envelopeError = decodeAgentChannelErrorResponse(parsedBody);
      if (envelopeError)
        throw new CliError({
          code: envelopeError.errorCode.toUpperCase(),
          message: envelopeError.error,
          retryable: false,
        });
      // Raft parity: an unknown channel is CliError code NOT_FOUND with a fixed message, not a
      // generic transport failure — for the operations that resolve a single #channel target
      // the same way Raft's join/leave/update/lifecycle/add-member/remove-member do.
      const targetOperations = new Set([
        "join",
        "leave",
        "update",
        "archive",
        "unarchive",
        "add-member",
        "remove-member",
      ]);
      if (response.status === 404 && command.target && targetOperations.has(command.operation))
        throw new CliError({
          code: "NOT_FOUND",
          message: `Channel not found: ${command.target}`,
          retryable: false,
        });
      throw new Error(
        `agent channel ${command.operation} request failed (${response.status}): ${rawText}`,
      );
    }
    return response.json();
  }

  /** A non-2xx maps like any other proxied operation: a refusal keeps the server's code, reason
   * and next step; anything else is `PREPARE_FAILED` or `SERVER_5XX`. */
  async function callActionPrepare(
    target: string,
    action: ActionCardAction,
  ): Promise<ActionPrepareResult> {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    let response: Response;
    try {
      response = await fetch(proxyEndpoint(agentApiRoutes.proxy.actionPrepare.path), {
        method: agentApiRoutes.local.actionPrepare.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify({ target, action }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CliError({
        code: "PREPARE_FAILED",
        message: "agent proxy request failed (network or timeout)",
        retryable: false,
      });
    }
    if (!response.ok)
      throw proxyHttpFailure(
        "prepare",
        response.status,
        await readProxyErrorBody(response),
        target,
      );
    return (await response.json()) as ActionPrepareResult;
  }

  async function callWeeklyReport(command: WeeklyReportCommand) {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.weeklyReports.path), {
      method: agentApiRoutes.proxy.weeklyReports.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        `agent weekly-report request failed (${response.status}): ${await response.text()}`,
      );
    return (await response.json()) as WeeklyReportResponse;
  }

  async function callWeeklyReportCollect(
    command: import("../index").WeeklyReportCollectCommand,
  ): Promise<import("../index").WeeklyReportCollectResult> {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.weeklyReportCollect.path), {
      method: agentApiRoutes.proxy.weeklyReportCollect.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(
        `agent weekly-report-collect request failed (${response.status}): ${await response.text()}`,
      );
    return (await response.json()) as import("../index").WeeklyReportCollectResult;
  }

  async function callWeeklyReportKeyPoints(
    command: import("../index").WeeklyReportKeyPointsCommand,
  ): Promise<import("../index").WeeklyReportKeyPointsResult> {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.weeklyReportKeyPoints.path), {
      method: agentApiRoutes.proxy.weeklyReportKeyPoints.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(
        `agent weekly-report-key-points request failed (${response.status}): ${await response.text()}`,
      );
    return (await response.json()) as import("../index").WeeklyReportKeyPointsResult;
  }
}
