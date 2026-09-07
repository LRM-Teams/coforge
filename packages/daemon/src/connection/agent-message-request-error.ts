import { AGENT_MESSAGE_VALIDATION_MESSAGES } from "@coforge/protocol";

const PUBLIC_AGENT_MESSAGE_ERRORS = new Set<string>(AGENT_MESSAGE_VALIDATION_MESSAGES);

/** An authenticated server validation failure safe to show to the Agent. */
export class AgentMessageRequestError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = "AgentMessageRequestError";
  }

  static fromRpc(code: number, message: string): AgentMessageRequestError | Error {
    return code === 400 && PUBLIC_AGENT_MESSAGE_ERRORS.has(message)
      ? new AgentMessageRequestError(message)
      : new Error(`server agent request failed (${code})`);
  }
}
