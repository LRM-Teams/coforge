import type { AgentMentionActionErrorCode } from "@lrm/coforge-sdk/agent";

/**
 * A well-formed `{ ok: false, errorCode, error }` response from the mention action routes
 * (`/api/agent/v1/mention-actions/...`). Carried through verbatim to the CLI instead of being
 * folded into the generic proxy-failure taxonomy.
 */
export class AgentMentionActionRequestError extends Error {
  readonly errorCode: AgentMentionActionErrorCode;
  readonly status: number;

  constructor(errorCode: AgentMentionActionErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentMentionActionRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
