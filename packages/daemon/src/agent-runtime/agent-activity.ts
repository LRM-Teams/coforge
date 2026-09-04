export type { AgentActivity, AgentActivityLevel, AgentActivityType } from "@coforge/agent";
import type { AgentActivity, AgentActivityLevel, AgentActivityType } from "@coforge/agent";

export function createAgentActivity(
  activity: AgentActivityType,
  level: AgentActivityLevel,
  message: string,
  occurredAt = new Date().toISOString(),
  diagnostic?: AgentActivity["diagnostic"],
): AgentActivity {
  return { activity, level, message, occurredAt, ...(diagnostic ? { diagnostic } : {}) };
}
