import type { RuntimeProvider } from "@coforge/protocol";
export type {
  AgentActivity,
  AgentActivityLevel,
  AgentActivityType,
  AgentDriver,
  AgentDriverFactory,
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentRuntimeProviderConfig,
  AgentSession,
  AgentSessionOptions,
} from "@coforge/agent";
export type CodeAgentProvider = RuntimeProvider;
export type { UsageSnapshot, UsageWindow } from "@coforge/agent";
export const AGENT_RUNTIME_EVENT_TYPE = { USAGE: "usage" } as const;
export class AgentProcessCleanupError extends Error {
  constructor() {
    super("code agent process tree did not exit");
    this.name = "AgentProcessCleanupError";
  }
}
