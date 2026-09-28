import {
  AgentTransportError,
  type AgentTransportFailureClass,
} from "#src/connection/agent-transport-error";
import { AgentMessageRequestError } from "#src/connection/agent-message-request-error";
import { AgentTaskRequestError } from "#src/connection/agent-task-request-error";
import { AgentUpstreamRefusalError } from "#src/connection/agent-upstream-refusal-error";
import { AgentWeeklyReportRequestError } from "#src/connection/agent-weekly-report-request-error";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";

/** Response header carrying the same correlation id as the JSON error body. */
export const AGENT_PROXY_CORRELATION_HEADER = "x-coforge-correlation-id";

export type AgentProxyFailureClass =
  | AgentTransportFailureClass
  | "local_precondition"
  | "request_validation"
  | "unclassified";

export type AgentProxyFailureBody = {
  error: string;
  code: string;
  detail?: string;
  suggested_next_action?: string;
  proxy: {
    layer: "local_daemon_proxy";
    correlation_id: string;
    route_family: string;
    failure_class: AgentProxyFailureClass;
    cause_code: string;
    upstream_layer?: string;
    upstream_status?: number;
    response_started: boolean;
    response_complete: boolean;
    /** Only ever set for `failure_class: "local_precondition"`; see `AgentPreflightError.draftSaved`. */
    draft_saved?: boolean;
  };
};

export type AgentProxyClassifiedFailure = {
  status: number;
  body: AgentProxyFailureBody;
  logFields: Record<string, unknown>;
};

const MAX_DETAIL_CHARS = 500;

/** The public `error` line per transport failure class; never claims an HTTP failure that did not happen. */
const TRANSPORT_PUBLIC_ERRORS: Record<AgentTransportFailureClass, string> = {
  pre_response_transport: "upstream request failed before a response was received",
  upstream_http_response: "upstream HTTP response failed",
  mid_response_transport: "upstream response failed while streaming",
  protocol_mismatch: "upstream response could not be decoded",
};

// Agent API keys (`sk_agent_…`), Local Proxy tokens (`sfp_…`) and bearer credentials: the detail is
// returned to the Agent and written to the daemon log, so none of them may ride along in a message.
const CREDENTIAL_IN_DETAIL = /\b(?:sk_[a-z]+_|sfp_)[A-Za-z0-9_-]{16,}|\bBearer\s+\S+/g;

/** The upstream statuses a business refusal may carry; anything else stays an opaque 502. */
const UPSTREAM_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 503]);

/** The caller-facing line per upstream refusal code. These are the route's own contract codes
 * (`CONFLICT`, `ACCESS_DENIED`, …), not internals: naming them is what makes a business rejection
 * actionable instead of arriving as a mystery 502. */
const UPSTREAM_REFUSAL_PUBLIC_ERRORS: Record<string, string> = {
  INVALID_INPUT: "the request was not valid for this operation",
  NOT_FOUND: "the referenced task or message does not exist",
  ACCESS_DENIED: "this agent is not allowed to do that",
  CONFLICT: "the task changed since you last read it; read the Task list again",
  TEMPORARILY_UNAVAILABLE: "the server is temporarily unavailable; retry",
};

/** Whitespace-normalises, strips credentials from, and bounds an error message. */
function boundedDetail(message: string): string {
  const normalized = message
    .replace(/\s+/g, " ")
    .trim()
    .replace(CREDENTIAL_IN_DETAIL, "[redacted]");
  return normalized.length > MAX_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_DETAIL_CHARS)}…`
    : normalized;
}

/**
 * Turns a thrown error into the local daemon proxy's JSON error contract: a status code, a JSON
 * body, and the fields to log once at WARN. `redact` is set for reviewer-isolated requests, which
 * must never learn more than that their request failed — no detail, no upstream status.
 */
export function classifyAgentProxyFailure(
  error: unknown,
  context: { method: string; path: string; routeFamily: string; agentId: string; redact?: boolean },
): AgentProxyClassifiedFailure {
  const correlationId = crypto.randomUUID();

  const build = (
    status: number,
    failureClass: AgentProxyFailureClass,
    causeCode: string,
    options: {
      publicError?: string;
      topLevelCode?: string;
      detail?: string;
      upstreamLayer?: string;
      upstreamStatus?: number;
      responseStarted?: boolean;
      responseComplete?: boolean;
      draftSaved?: boolean;
      /** Log only: the upstream body's own `code`, which explains a refusal that the caller is
       * deliberately not shown the internals of. Never enters `body`. */
      upstreamCode?: string;
    } = {},
  ): AgentProxyClassifiedFailure => {
    const body: AgentProxyFailureBody = {
      error: options.publicError ?? "upstream HTTP response failed",
      code: options.topLevelCode ?? "agent_proxy_failed",
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
      proxy: {
        layer: "local_daemon_proxy",
        correlation_id: correlationId,
        route_family: context.routeFamily,
        failure_class: failureClass,
        cause_code: causeCode,
        ...(options.upstreamLayer !== undefined ? { upstream_layer: options.upstreamLayer } : {}),
        ...(options.upstreamStatus !== undefined
          ? { upstream_status: options.upstreamStatus }
          : {}),
        response_started: options.responseStarted ?? false,
        response_complete: options.responseComplete ?? false,
        ...(options.draftSaved !== undefined ? { draft_saved: options.draftSaved } : {}),
      },
    };
    return {
      status,
      body,
      logFields: {
        correlation: correlationId,
        failure_class: body.proxy.failure_class,
        cause_code: body.proxy.cause_code,
        ...(options.detail !== undefined ? { detail: options.detail } : {}),
        upstream_status: body.proxy.upstream_status,
        ...(options.upstreamCode !== undefined ? { upstream_code: options.upstreamCode } : {}),
        response_started: body.proxy.response_started,
        response_complete: body.proxy.response_complete,
        method: context.method,
        path: context.path,
        agent_id: context.agentId,
      },
    };
  };

  // A local precondition names a caller-fixable local condition and carries no upstream detail,
  // so it stays classified even for a reviewer-isolated request.
  if (error instanceof AgentPreflightError)
    return build(400, "local_precondition", error.code, {
      publicError: error.message,
      topLevelCode: error.code,
      responseStarted: false,
      responseComplete: false,
      draftSaved: error.draftSaved,
    });

  if (context.redact)
    return build(502, "unclassified", "REVIEWER_ISOLATION_WITHHELD", {
      publicError: "upstream request failed; detail withheld",
    });

  if (error instanceof AgentTransportError) {
    const status =
      error.failureClass === "upstream_http_response" && error.upstreamStatus !== undefined
        ? error.upstreamStatus
        : 502;
    return build(status, error.failureClass, error.causeCode, {
      publicError: TRANSPORT_PUBLIC_ERRORS[error.failureClass],
      detail: boundedDetail(error.message),
      upstreamLayer: error.upstreamLayer,
      upstreamStatus: error.upstreamStatus,
      responseStarted: error.responseStarted,
      responseComplete: error.responseComplete,
    });
  }

  if (
    error instanceof AgentMessageRequestError ||
    error instanceof AgentTaskRequestError ||
    error instanceof AgentWeeklyReportRequestError
  ) {
    const topLevelCode =
      error instanceof AgentMessageRequestError
        ? "AGENT_MESSAGE_VALIDATION_FAILED"
        : error instanceof AgentTaskRequestError
          ? "AGENT_TASK_VALIDATION_FAILED"
          : "AGENT_WEEKLY_REPORT_VALIDATION_FAILED";
    return build(400, "request_validation", topLevelCode, {
      publicError: error.message,
      topLevelCode,
      responseStarted: true,
      responseComplete: true,
    });
  }

  // A refusal the upstream named with a business code (a 403 "this agent is not allowed", a 409
  // "the task changed since you saw it") is not a transport failure: the caller gets the real
  // status and that code, so a claim of an already-claimed task is a 409, not a 502. Reviewer
  // isolation keeps the opaque form — a redacted request learns only that its request failed.
  if (
    error instanceof AgentUpstreamRefusalError &&
    !context.redact &&
    error.upstreamStatus !== undefined &&
    error.upstreamCode !== undefined
  ) {
    const publicError = UPSTREAM_REFUSAL_PUBLIC_ERRORS[error.upstreamCode];
    if (publicError !== undefined && UPSTREAM_REFUSAL_STATUSES.has(error.upstreamStatus)) {
      return build(error.upstreamStatus, "upstream_http_response", error.upstreamCode, {
        publicError,
        topLevelCode: error.upstreamCode,
        upstreamStatus: error.upstreamStatus,
        responseStarted: true,
        responseComplete: true,
      });
    }
  }

  return build(502, "unclassified", "UNCLASSIFIED_PROXY_FAILURE", {
    detail: boundedDetail(error instanceof Error ? error.message : String(error)),
    // A refusal this layer could not classify is exactly the case where the server's own code is
    // the only thing that says what happened; the caller still gets the correlation id and nothing
    // else, and the code is written to the daemon log beside it.
    ...(error instanceof AgentUpstreamRefusalError && error.upstreamCode !== undefined
      ? { upstreamCode: error.upstreamCode }
      : {}),
  });
}
