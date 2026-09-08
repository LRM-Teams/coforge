export type { AgentActivity, AgentActivityLevel, AgentActivityType } from "@coforge/agent";
import type { AgentActivity, AgentActivityLevel, AgentActivityType } from "@coforge/agent";

export function createAgentActivity(
  detailKind: AgentActivityType,
  level: AgentActivityLevel,
  detail: string,
  occurredAt = new Date().toISOString(),
  runtimeError?: AgentActivity["runtimeError"],
): AgentActivity {
  return {
    detailKind,
    level,
    detail,
    observedAtMs: Date.parse(occurredAt),
    ...(runtimeError ? { runtimeError } : {}),
  };
}
