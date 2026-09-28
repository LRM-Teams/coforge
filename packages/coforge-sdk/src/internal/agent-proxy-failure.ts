/**
 * The local Agent proxy's JSON error contract (daemon → CLI). The daemon's
 * `agent-proxy-failure.ts` builds it; the CLI reads it. Field names are snake_case on this hop.
 */
export type AgentProxyFailureClass =
  | "pre_response_transport"
  | "upstream_http_response"
  | "mid_response_transport"
  | "protocol_mismatch"
  | "local_precondition"
  | "request_validation"
  | "unclassified";

/** Code-specific data a local precondition carries for the caller's `--json` output. */
export type AgentProxyFailureDetails = {
  /** `SEND_DRAFT_EXPIRED`: the discarded draft, whose body is its last copy. */
  discarded_draft?: { content: string; saved_at: string };
};

export type AgentProxyFailureBody = {
  error: string;
  code: string;
  detail?: string;
  /** `suggested_next_action`, `retryable` and `proxy.draft_saved` come from the daemon's verdict
   * when the failure carries one. An absent `retryable` means "decide from the class". */
  suggested_next_action?: string;
  retryable?: boolean;
  details?: AgentProxyFailureDetails;
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
    /** From the verdict: a `local_precondition` that saved a draft, or a failed same-key replay,
     * where it says whether the draft still holds that send's key. */
    draft_saved?: boolean;
  };
};
