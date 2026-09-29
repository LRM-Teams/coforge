import { decodeAgentApiRefusal } from "@lrm/coforge-sdk/agent";

/**
 * A request the server refused with a reason written for the Agent: a 4xx whose body is exactly
 * the Agent API's refusal shape (`{ error, code?, retryable? }`). Unlike `AgentUpstreamRefusalError`,
 * whose reason is kept for the daemon's log only, this one is relayed to the caller with its code,
 * so an Agent learns why (`DM_PEER_NOT_IN_WORKSPACE`) instead of "upstream HTTP response failed".
 */
export class AgentExplainedRefusalError extends Error {
  private constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "AgentExplainedRefusalError";
  }

  /**
   * The refusal a non-2xx response carries, or `undefined` when it carries none. Only a 4xx can be
   * one: a 401 is the credential boundary's answer, not a reason, and a 5xx leaves a send's outcome
   * unknown, so it must stay a transport failure that the send settlement reconciles.
   */
  static fromResponse(status: number, body: string): AgentExplainedRefusalError | undefined {
    if (status < 400 || status >= 500 || status === 401) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    const refusal = decodeAgentApiRefusal(parsed);
    return refusal
      ? new AgentExplainedRefusalError(refusal.error, status, refusal.code, refusal.retryable)
      : undefined;
  }
}
