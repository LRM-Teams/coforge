export type AgentActivityType =
  | "starting"
  | "stopped"
  | "turn_completed"
  | "idle"
  | "running_command"
  | "reading_file"
  | "writing_file"
  | "editing_file"
  | "error"
  | "warning";

export type AgentActivityLevel = "info" | "warning" | "error";

export type AgentActivity = Readonly<{
  activity: AgentActivityType;
  level: AgentActivityLevel;
  message: string;
  occurredAt: string;
}>;

export function createAgentActivity(
  activity: AgentActivityType,
  level: AgentActivityLevel,
  message: string,
  occurredAt = new Date().toISOString(),
): AgentActivity {
  return { activity, level, message, occurredAt };
}
