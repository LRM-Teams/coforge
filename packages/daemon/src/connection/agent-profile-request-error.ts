import type { AgentProfileErrorCode } from "@lrm/coforge-sdk/agent";

/**
 * A well-formed `{ ok: false, errorCode, error }` response from `GET`/`POST
 * /api/agent/v1/profile` (same envelope convention as the Agent Manual routes).
 * Carried through verbatim to the CLI instead of being folded into the generic proxy-failure
 * taxonomy.
 */
export class AgentProfileRequestError extends Error {
  readonly errorCode: AgentProfileErrorCode;
  readonly status: number;

  constructor(errorCode: AgentProfileErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentProfileRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
