import type { AgentMentionDeliveryErrorCode } from "@lrm/coforge-sdk/agent";

/**
 * A well-formed `{ ok: false, errorCode, error }` response from mention delivery
 * (`GET /api/agent/v1/messages/:messageId/mention-deliveries`). Carried through verbatim to the
 * CLI instead of being folded into the generic proxy-failure taxonomy.
 */
export class AgentMentionDeliveryRequestError extends Error {
  readonly errorCode: AgentMentionDeliveryErrorCode;
  readonly status: number;

  constructor(errorCode: AgentMentionDeliveryErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentMentionDeliveryRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
