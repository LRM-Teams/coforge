/** An authenticated weekly-report validation failure safe to show to the Agent. */
export class AgentWeeklyReportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWeeklyReportRequestError";
  }
}
