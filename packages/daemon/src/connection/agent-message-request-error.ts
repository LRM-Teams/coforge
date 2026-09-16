import { AGENT_MESSAGE_VALIDATION_MESSAGES } from "@lrm/coforge-sdk/internal";
import { AgentTransportError } from "./agent-transport-error";

const PUBLIC_AGENT_MESSAGE_ERRORS = new Set<string>(AGENT_MESSAGE_VALIDATION_MESSAGES);

/** An authenticated server validation failure safe to show to the Agent. */
export class AgentMessageRequestError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = "AgentMessageRequestError";
  }

  /**
   * A known-safe validation message (400) becomes an `AgentMessageRequestError`, unchanged. Any
   * other non-2xx status is a genuine upstream HTTP failure and becomes a typed
   * `AgentTransportError` so `agent-proxy-failure.ts` can classify it instead of parsing text.
   */
  static fromRpc(code: number, message: string): AgentMessageRequestError | AgentTransportError {
    return code === 400 && PUBLIC_AGENT_MESSAGE_ERRORS.has(message)
      ? new AgentMessageRequestError(message)
      : AgentTransportError.upstreamHttpResponse("server agent request", code);
  }
}
