export type { AgentActivity, AgentActivityLevel } from "@coforge/agent";
import type { AgentActivity, AgentActivityLevel } from "@coforge/agent";
import type { AgentActivityDetailKind } from "@coforge/protocol";

export function createAgentActivity(
  detailKind: AgentActivityDetailKind,
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
