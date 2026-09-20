import {
  AGENT_MESSAGE_VALIDATION_MESSAGES,
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
  type ActionCardAction,
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

/**
 * A legacy or pre-request-validation daemon may still answer with a bare-text body (never JSON):
 * the fixed literals `agent-proxy.ts` uses for its own request parsing (`"not found"`, `"bad
 * request"`, ...) and this known-safe validation-message allowlist. Anything else, this client
 * never relays verbatim — it could be arbitrary exception text from an unmigrated daemon build.
 */
const SAFE_LEGACY_PROXY_TEXT = new Set<string>(AGENT_MESSAGE_VALIDATION_MESSAGES);

/** The local daemon proxy's JSON error body shape (see `agent-proxy-failure.ts`). Best-effort: a
 * legacy or pre-request-validation daemon response may still be a bare text body, which
 * `readProxyErrorBody` tolerates. */
type AgentProxyErrorBody = {
  error?: string;
  code?: string;
  detail?: string;
  suggested_next_action?: string;
  proxy?: {
    correlation_id?: string;
    route_family?: string;
    failure_class?: string;
    cause_code?: string;
    upstream_layer?: string;
    upstream_status?: number;
    response_started?: boolean;
    response_complete?: boolean;
    draft_saved?: boolean;
  };
};

/** Reads a non-ok proxy response body once, parsing it as the JSON error contract when possible. */
async function readProxyErrorBody(
  response: Response,
): Promise<{ text: string; json?: AgentProxyErrorBody }> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "code" in parsed)
      return { text, json: parsed as AgentProxyErrorBody };
  } catch {
    // A legacy bare-text proxy error (e.g. unauthorized/not found); fall through with just `text`.
  }
  return { text };
}

function operationFailedCode(operation: string): string {
  return `${operation.toUpperCase().replace(/-/g, "_")}_FAILED`;
}

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

/**
 * Classifies a non-ok proxy response (or a network failure reaching the proxy) into a `CliError`.
 * `send` failures raised here happened AFTER the daemon saved the local draft and handed the
 * request to its transport (see `runtime.ts#sendAgentMessage`): delivery state is unknown, so they
 * are never retryable from this evidence alone (Raft-aligned; see `cli-error.ts`).
 */
function proxyHttpFailure(
  operation: string,
  status: number,
  body: { text: string; json?: AgentProxyErrorBody },
  target: string | undefined,
): CliError {
  const isSend = operation === "send";
  const proxy = body.json?.proxy;
  const isLocalPrecondition = proxy?.failure_class === "local_precondition";
  // A local precondition usually means nothing was saved, but a guard that saves a draft before
  // refusing (e.g. --target-confirmed) says so explicitly via `draft_saved`; honour it when present.
  const draftSaved = proxy?.draft_saved !== undefined ? proxy.draft_saved : !isLocalPrecondition;
  const legacyText = body.text && SAFE_LEGACY_PROXY_TEXT.has(body.text) ? body.text : undefined;
  const message = body.json?.error || legacyText || `HTTP ${status}`;
  const code = failureCode(operation, status, body.json);
  return new CliError({
    code,
    message,
    retryable: false,
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
    suggestedNextAction: isSend
      ? isLocalPrecondition
        ? NO_MESSAGE_SENT_NEXT_ACTION
        : unknownDeliveryNextAction(target ?? "")
      : body.json?.suggested_next_action,
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

/** How many times a `send` is attempted before its delivery state is reported as unknown, the base
 * delay between attempts (doubled each time: 250ms, 500ms), and a hard ceiling on the whole retry
 * window. The window stays under the server's 30s "processing" idempotency TTL
 * (`redis-message-request-idempotency.server.ts`), so a retry always finds its own requestId still
 * claimed and can never re-execute a send the server already accepted. */
const SEND_RETRY_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 250;
const SEND_RETRY_DEADLINE_MS = 25_000;

/**
 * Whether a `send` failure is worth retrying with the SAME `requestId`. A send is idempotent end
 * to end — the daemon forwards this `requestId` to the cloud and the server suppresses a duplicate
 * by it (`message-request-idempotency`) — so a retry either lands the message the first attempt
 * failed to deliver or returns the one it already persisted. Only transient transport/gateway
 * failures qualify: a 4xx, a `local_precondition` (e.g. the thread-target guard), or a protocol
 * mismatch is answered the same way however many times it is sent.
 */
function isRetryableSendFailure(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  // Nothing answered: the CLI could not reach the local proxy at all.
  if (!error.proxy) return error.code === "SEND_FAILED";
  const failureClass = error.proxy.failureClass;
  if (failureClass === "pre_response_transport" || failureClass === "mid_response_transport")
    return true;
  if (failureClass !== "upstream_http_response") return false;
  const status = error.proxy.upstreamStatus;
  // 5xx is a gateway/upstream fault; 409 is the server's own "this requestId is still processing".
  return status !== undefined && (status >= 500 || status === 409);
}

function manualFailedCode(errorCode: string | undefined): string {
  return errorCode ? errorCode.toUpperCase() : "MANUAL_FAILED";
}

/**
 * GETs one of the two Agent Manual routes (`ADR 0036`) through the local daemon proxy. Unlike
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
  if (!context) throw preIssuanceError("manual", "coforge agent context is not configured");
  if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
    throw preIssuanceError("manual", "coforge agent context is invalid");
  if (!proxyUrl) throw preIssuanceError("manual", "coforge agent proxy is not configured");
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
 * GETs the local-only `/api/agent/v1/version` route (ADR 0036's placement-table rows): unlike
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
  if (!context) throw preIssuanceError("version", "coforge agent context is not configured");
  if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
    throw preIssuanceError("version", "coforge agent context is invalid");
  if (!proxyUrl) throw preIssuanceError("version", "coforge agent proxy is not configured");
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
  if (!context) throw preIssuanceError(operation, "coforge agent context is not configured");
  if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
    throw preIssuanceError(operation, "coforge agent context is invalid");
  if (!proxyUrl) throw preIssuanceError(operation, "coforge agent proxy is not configured");
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
  if (!context) throw preIssuanceError("profile-update", "coforge agent context is not configured");
  if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
    throw preIssuanceError("profile-update", "coforge agent context is invalid");
  if (!proxyUrl) throw preIssuanceError("profile-update", "coforge agent proxy is not configured");
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
    const requestId = crypto.randomUUID();
    if (!proxyUrl) throw preIssuanceError(operation, "coforge agent proxy is not configured");
    const attemptRequest = async (): Promise<Response> => {
      let response: Response;
      try {
        response = await fetch(proxyEndpoint(agentApiRoutes.proxy.messages.path), {
          method: agentApiRoutes.local.messages.method,
          headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
          body: JSON.stringify({ requestId, operation, target, content: body, ...options }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw proxyTransportFailure(operation, target);
      }
      if (!response.ok) {
        const errorBody = await readProxyErrorBody(response);
        if (
          options?.freshnessContextMode === "withheld" &&
          errorBody.json?.proxy?.failure_class !== "local_precondition"
        ) {
          const label = operation === "send" ? "send" : `${operation} request`;
          throw new CliError({
            code: response.status >= 500 ? "SERVER_5XX" : operationFailedCode(operation),
            message: `Reviewer-isolation ${label} failed (HTTP ${response.status}); upstream error detail was withheld.`,
            retryable: false,
            ...(operation === "send"
              ? { draftSaved: true, suggestedNextAction: unknownDeliveryNextAction(target ?? "") }
              : {}),
            proxy: { upstreamStatus: response.status },
          });
        }
        throw proxyHttpFailure(operation, response.status, errorBody, target);
      }
      return response;
    };
    // A `send` retries with the same requestId: the daemon forwards that id to the cloud and the
    // server suppresses a duplicate by it, so a transient failure no longer has to end in silence.
    // Every other operation keeps the single attempt it had before.
    const retryDeadline = Date.now() + SEND_RETRY_DEADLINE_MS;
    let response: Response | undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await attemptRequest();
        break;
      } catch (error) {
        if (
          operation !== "send" ||
          attempt >= SEND_RETRY_ATTEMPTS - 1 ||
          Date.now() >= retryDeadline ||
          !isRetryableSendFailure(error)
        )
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, SEND_RETRY_BASE_DELAY_MS * 2 ** attempt),
        );
      }
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
    check: () => call("check"),
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
    channel: (command: Omit<ChannelCommand, "requestId">) => callChannel(command),
    actionPrepare: (target: string, action: ActionCardAction) => callActionPrepare(target, action),
    workspaceInfo: async (): Promise<WorkspaceInfoResponse> => {
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
    // The GET attachment-download forwarding (`agent-proxy.ts`) treats any segment after the
    // attachment route prefix as an opaque attachment id and reaches the identical cloud URL
    // unchanged. "capabilities" is itself a literal cloud sub-route registered ahead of
    // `$attachmentId`, so this coincidentally-shaped request reaches it without any daemon
    // change. Covered by a `local-client.test.ts` case; if a future daemon route ordering
    // change breaks this, add explicit forwarding in `agent-proxy.ts` instead of relying on it.
    endpoint.pathname = agentApiRoutes.local.attachments.path("capabilities");
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

  /** Reads a non-ok local-proxy JSON error body, tolerating a legacy bare-text body. */
  async function readAttachmentErrorBody(
    response: Response,
  ): Promise<{ message: string; code?: string; retryable?: boolean }> {
    const text = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as { error?: string; code?: string; retryable?: boolean };
      if (parsed && typeof parsed.error === "string")
        return { message: parsed.error, code: parsed.code, retryable: parsed.retryable };
    } catch {
      // Not JSON: keep the raw text (e.g. a legacy bare-text proxy error).
    }
    return { message: text };
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
      if (!response.ok) {
        const { message } = await readAttachmentErrorBody(response);
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : "UPLOAD_FAILED",
          message: message || `HTTP ${response.status}`,
          retryable: false,
        });
      }
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
          clientRequestId: crypto.randomUUID(),
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
    if (!response.ok) {
      const { message, code } = await readAttachmentErrorBody(response);
      throw new CliError({
        code: code ?? (response.status >= 500 ? "SERVER_5XX" : "UPLOAD_FAILED"),
        message: message || `HTTP ${response.status}`,
        retryable: false,
      });
    }
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
      const completed = await callAttachmentUploadSessionComplete(created.uploadId);
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
    const { message, code, retryable } = await readAttachmentErrorBody(response);
    return {
      ok: false,
      retryable: retryable === true,
      error: new CliError({
        code: code ?? (response.status >= 500 ? "SERVER_5XX" : "UPLOAD_FAILED"),
        message: message || `HTTP ${response.status}`,
        retryable: retryable === true,
      }),
    };
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
      body: JSON.stringify({ requestId: crypto.randomUUID(), operation: "check" }),
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
    const requestId = crypto.randomUUID();
    const validated = decodeLocalReminderRequest(
      encodeLocalReminderRequest({ ...fields, requestId, context } as LocalReminderRequest),
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
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.tasks.path), {
      method: agentApiRoutes.local.tasks.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (command.freshnessContextMode === "withheld")
        throw new Error(
          `reviewer-isolation Task request failed (${response.status}); upstream detail withheld`,
        );
      throw new Error(`agent Task request failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as TaskResult;
  }

  async function callChannel(command: Omit<ChannelCommand, "requestId">) {
    if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const requestId = crypto.randomUUID();
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.channels.path), {
      method: agentApiRoutes.local.channels.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify({ ...command, requestId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
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
        `agent channel ${command.operation} request failed (${response.status}): ${await response.text()}`,
      );
    }
    return response.json();
  }

  /** Server non-2xx maps to `PREPARE_FAILED` (4xx, server error text) or `SERVER_5XX`. */
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
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text;
      try {
        const json = JSON.parse(text) as { error?: string; message?: string };
        message = json.message || json.error || text;
      } catch {
        // A legacy or bare-text proxy error; fall through with the raw text.
      }
      throw new CliError({
        code: response.status >= 500 ? "SERVER_5XX" : "PREPARE_FAILED",
        message: message || `HTTP ${response.status}`,
        retryable: false,
      });
    }
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
