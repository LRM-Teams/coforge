import {
  AGENT_MESSAGE_VALIDATION_MESSAGES,
  decodeAgentMessageResponse,
  decodeAgentReminderOperationResponse,
  decodeLocalReminderRequest,
  encodeAgentReminderOperationResponse,
  encodeLocalReminderRequest,
  type AgentReminderOperationResponse,
  type LocalReminderRequest,
  type TaskCommand,
  type TaskResult,
  type WorkspaceInfoResponse,
  type WeeklyReportCommand,
  type WeeklyReportResponse,
} from "@lrm/coforge-sdk/internal";
import type { LocalReminderReceiptResponse, ReminderTransportRequest } from "../index";
import { agentApiRoutes, decodeGitHubCredentialResponse } from "@lrm/coforge-sdk/agent";
import { CliError, NO_MESSAGE_SENT_NEXT_ACTION, unknownDeliveryNextAction } from "./cli-error";

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
  const legacyText = body.text && SAFE_LEGACY_PROXY_TEXT.has(body.text) ? body.text : undefined;
  const message = body.json?.error || legacyText || `HTTP ${status}`;
  const code = failureCode(operation, status, body.json);
  return new CliError({
    code,
    message,
    retryable: false,
    ...(isSend ? { draftSaved: !isLocalPrecondition } : {}),
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
    },
  ) => {
    if (!context) throw preIssuanceError(operation, "coforge agent context is not configured");
    if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw preIssuanceError(operation, "coforge agent context is invalid");
    const requestId = crypto.randomUUID();
    if (!proxyUrl) throw preIssuanceError(operation, "coforge agent proxy is not configured");
    let response: Response;
    try {
      response = await fetch(proxyEndpoint(agentApiRoutes.proxy.messages.path), {
        method: agentApiRoutes.local.messages.method,
        headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
        body: JSON.stringify({ requestId, operation, target, body, ...options }),
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
      },
    ) => call("send", target, body, options),
    resolve: (messageId: string) => call("resolve", undefined, undefined, { messageId }),
    react: (messageId: string, emoji: string, remove?: boolean) =>
      call(remove ? "unreact" : "react", undefined, undefined, { messageId, emoji }),
    task: (command: TaskCommand) => callTask(command),
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
      if (!response.ok) throw new Error(`attachment download failed (${response.status})`);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        fileName: response.headers.get("content-disposition") ?? undefined,
      };
    },
    upload: (input: { path: string; target: string; mimeType?: string }) =>
      callAttachmentUpload(input),
  };

  async function callAttachmentCapabilities(): Promise<{ maxBytes: number }> {
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
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`attachment capabilities request failed (${response.status})`);
    return (await response.json()) as { maxBytes: number };
  }

  async function callAttachmentUpload(input: { path: string; target: string; mimeType?: string }) {
    if (!context) throw new Error("coforge agent context is not configured");
    if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
      throw new Error("coforge agent context is invalid");
    if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
    const file = Bun.file(input.path);
    const sizeBytes = file.size;
    const capabilities = await callAttachmentCapabilities();
    if (sizeBytes > capabilities.maxBytes)
      throw new CliError({
        code: "ATTACHMENT_TOO_LARGE",
        message: `File is ${sizeBytes} bytes; the server allows at most ${capabilities.maxBytes} bytes.`,
        retryable: false,
      });
    const fileName = input.path.split("/").pop() || "attachment";
    const form = new FormData();
    form.set("file", new Blob([await file.arrayBuffer()], { type: input.mimeType }), fileName);
    form.set("target", input.target);
    if (input.mimeType) form.set("mimeType", input.mimeType);
    const endpoint = new URL(proxyUrl);
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
      const text = await response.text().catch(() => "");
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed && typeof parsed.error === "string") message = parsed.error;
      } catch {
        // Not JSON: keep the raw text (e.g. a legacy bare-text proxy error).
      }
      throw new CliError({
        code: response.status >= 500 ? "SERVER_5XX" : "UPLOAD_FAILED",
        message: message || `HTTP ${response.status}`,
        retryable: false,
      });
    }
    return (await response.json()) as {
      id: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    };
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
}
