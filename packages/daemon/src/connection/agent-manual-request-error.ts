import type { AgentManualErrorCode } from "@lrm/coforge-sdk/agent";

/**
 * A well-formed `{ ok: false, errorCode, error }` response from an Agent Manual route.
 * Unlike the multiplexed `messages` operations, the Manual routes always answer domain errors as
 * JSON with a stable `errorCode`, so this carries that shape through verbatim instead of folding
 * it into the generic proxy-failure taxonomy in `agent-proxy-failure.ts`.
 */
export class AgentManualRequestError extends Error {
  readonly errorCode: AgentManualErrorCode;
  readonly status: number;

  constructor(errorCode: AgentManualErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentManualRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
