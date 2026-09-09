/** An authenticated Task validation/conflict failure safe to show to the Agent. */
export class AgentTaskRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTaskRequestError";
  }
}
