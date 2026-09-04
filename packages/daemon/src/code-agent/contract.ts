import type { AgentActivity } from "../agent-runtime/agent-activity";
import type { RuntimeProvider } from "@coforge/protocol";

/** Provider-neutral seam owned by the daemon's Agent runtime manager. */
export type CodeAgentProvider = RuntimeProvider;

export type AgentRuntimeProviderConfig =
  | Readonly<{ kind: "default" }>
  | Readonly<{ kind: "pi-builtin"; providerId: string; apiKey?: string }>;

export type AgentRuntimeConfig = Readonly<{
  provider: CodeAgentProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  providerConfig?: AgentRuntimeProviderConfig;
}>;

export const AGENT_RUNTIME_EVENT_TYPE = {
  USAGE: "usage",
} as const;

export type AgentRuntimeEvent =
  | { type: "activity"; activity: AgentActivity }
  | { type: typeof AGENT_RUNTIME_EVENT_TYPE.USAGE; snapshot: UsageSnapshot }
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-output"; id: string; text: string }
  | { type: "tool-end"; id: string; isError: boolean }
  | { type: "completed"; status: "completed" | "interrupted" | "failed" };

export type UsageWindow = Readonly<{
  usedPercent?: number;
  status?: "available" | "rate-limited";
  windowDurationMinutes: number;
  resetsAt: string;
}>;

export type UsageSnapshot = Readonly<{
  provider: CodeAgentProvider;
  planType?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: Readonly<{ hasCredits: boolean; unlimited: boolean }>;
}>;

export interface CodeAgentUsageReader {
  readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null>;
}

export class AgentProcessCleanupError extends Error {
  constructor() {
    super("code agent process tree did not exit");
    this.name = "AgentProcessCleanupError";
  }
}

export interface CodeAgentSession {
  sendMessage(message: string): Promise<void>;
  /** Non-canonical wakeup; contains no message body. */
  notify?(notice: string): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
  interrupt(): Promise<void>;
  onExit(listener: () => void): () => void;
  dispose(): Promise<void>;
}

export interface CodeAgentStartOptions {
  agentId?: string;
  runtimeId?: string;
  agentWorkspaceDirectory: string;
  /** Existing provider session to resume; adapters own provider-specific semantics. */
  sessionId?: string;
  runtime?: AgentRuntimeConfig;
  environment?: Readonly<Record<string, string>>;
}

export interface CodeAgentAdapter {
  readonly provider: CodeAgentProvider;
  start(options: CodeAgentStartOptions): Promise<CodeAgentSession>;
  readUsage?(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null>;
}
