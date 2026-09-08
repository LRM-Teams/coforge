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

export type AgentSessionRecoveryCode =
  | "session_missing"
  | "session_in_use"
  | "provider_replay_rejected";

/** Safe signal that lifecycle may retry this launch once without a native session ID. */
export class AgentSessionRecoveryError extends Error {
  constructor(readonly code: AgentSessionRecoveryCode) {
    super(`code agent session recovery required: ${code}`);
    this.name = "AgentSessionRecoveryError";
  }
}
