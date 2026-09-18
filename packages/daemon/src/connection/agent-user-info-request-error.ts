import type { AgentUserInfoErrorCode } from "@lrm/coforge-sdk/agent";

/**
 * A well-formed `{ ok: false, errorCode, error }` response from `GET /api/agent/v1/users/:name`
 * (same envelope convention as the Agent Manual routes, ADR 0036). Carried through verbatim to
 * the CLI instead of being folded into the generic proxy-failure taxonomy.
 */
export class AgentUserInfoRequestError extends Error {
  readonly errorCode: AgentUserInfoErrorCode;
  readonly status: number;

  constructor(errorCode: AgentUserInfoErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentUserInfoRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
