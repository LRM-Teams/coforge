export type AgentActivityType =
  | "working"
  | "freshness_hold"
  | "starting"
  | "stopped"
  | "turn_completed"
  | "idle"
  | "running_command"
  | "reading_file"
  | "writing_file"
  | "editing_file"
  | "using_tool"
  | "error"
  | "warning";

export type AgentActivityLevel = "info" | "warning" | "error";

export type AgentActivity = Readonly<{
  activity: AgentActivityType;
  level: AgentActivityLevel;
  message: string;
  occurredAt: string;
  diagnostic?: Readonly<{
    errorClass: string;
    reason: string;
    fingerprint: string;
  }>;
}>;

export function createAgentActivity(
  activity: AgentActivityType,
  level: AgentActivityLevel,
  message: string,
  occurredAt = new Date().toISOString(),
  diagnostic?: AgentActivity["diagnostic"],
): AgentActivity {
  return { activity, level, message, occurredAt, ...(diagnostic ? { diagnostic } : {}) };
}
