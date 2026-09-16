/**
 * A typed failure from the daemon's Agent-message HTTP transport (daemon -> Web/backend). Carries
 * exactly what `agent-proxy-failure.ts` needs to classify a failure into the local daemon proxy's
 * JSON error contract, without parsing error message strings: whether a response was ever
 * received, its status when known, and whether the body was fully read.
 */
export type AgentTransportFailureClass =
  | "pre_response_transport"
  | "upstream_http_response"
  | "mid_response_transport"
  | "protocol_mismatch";

export type AgentTransportUpstreamLayer =
  | "dns"
  | "tcp"
  | "tls"
  | "read_timeout"
  | "http_status"
  | "body_stream"
  | "response_decode";

export interface AgentTransportErrorDetails {
  failureClass: AgentTransportFailureClass;
  causeCode: string;
  upstreamLayer?: AgentTransportUpstreamLayer;
  upstreamStatus?: number;
  responseStarted: boolean;
  responseComplete: boolean;
}

export class AgentTransportError extends Error implements AgentTransportErrorDetails {
  readonly failureClass: AgentTransportFailureClass;
  readonly causeCode: string;
  readonly upstreamLayer?: AgentTransportUpstreamLayer;
  readonly upstreamStatus?: number;
  readonly responseStarted: boolean;
  readonly responseComplete: boolean;

  constructor(message: string, details: AgentTransportErrorDetails) {
    super(message);
    this.name = "AgentTransportError";
    this.failureClass = details.failureClass;
    this.causeCode = details.causeCode;
    this.upstreamLayer = details.upstreamLayer;
    this.upstreamStatus = details.upstreamStatus;
    this.responseStarted = details.responseStarted;
    this.responseComplete = details.responseComplete;
  }

  /** The request never reached the upstream server, or no response ever came back. */
  static preResponseTransport(what: string, cause: unknown): AgentTransportError {
    return new AgentTransportError(`${what} failed before a response was received`, {
      failureClass: "pre_response_transport",
      causeCode: causeCode(cause),
      responseStarted: false,
      responseComplete: false,
    });
  }

  /** The upstream server answered with a non-2xx HTTP status. */
  static upstreamHttpResponse(what: string, status: number): AgentTransportError {
    return new AgentTransportError(`${what} failed (${status})`, {
      failureClass: "upstream_http_response",
      causeCode: `HTTP_${status}`,
      upstreamLayer: "http_status",
      upstreamStatus: status,
      responseStarted: true,
      responseComplete: true,
    });
  }

  /** The upstream response started (a status/headers arrived) but its body never finished. */
  static midResponseTransport(what: string, status: number, cause: unknown): AgentTransportError {
    return new AgentTransportError(`${what} response body failed while streaming`, {
      failureClass: "mid_response_transport",
      causeCode: causeCode(cause),
      upstreamLayer: "body_stream",
      upstreamStatus: status,
      responseStarted: true,
      responseComplete: false,
    });
  }

  /** The upstream response completed but the daemon could not decode or validate its shape. */
  static protocolMismatch(what: string, status: number, detail: string): AgentTransportError {
    return new AgentTransportError(`${what}: ${detail}`, {
      failureClass: "protocol_mismatch",
      causeCode: "AGENT_RESPONSE_SHAPE_INVALID",
      upstreamLayer: "response_decode",
      upstreamStatus: status,
      responseStarted: true,
      responseComplete: true,
    });
  }
}

function causeCode(cause: unknown): string {
  if (cause instanceof DOMException)
    return cause.name === "AbortError" ? "READ_TIMEOUT" : cause.name;
  if (cause && typeof cause === "object" && "name" in cause) return String((cause as Error).name);
  return "TRANSPORT_FAILURE";
}
