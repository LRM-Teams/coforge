import type { AgentMessageValidationMessage } from "@coforge/protocol";

/** A validation failure that is safe to return to an authenticated Agent. */
export class AgentMessageValidationError extends Error {
  constructor(message: AgentMessageValidationMessage) {
    super(message);
    this.name = "AgentMessageValidationError";
  }
}
