import type { RuntimeProvider } from "@coforge/protocol";

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
  diagnostic?: Readonly<{ errorClass: string; reason: string; fingerprint: string }>;
}>;

export type AgentRuntimeProviderConfig =
  | Readonly<{ kind: "default" }>
  | Readonly<{ kind: "coforge"; providerId: string; apiKey?: string }>;
export type AgentRuntimeConfig = Readonly<{
  provider: RuntimeProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  providerConfig?: AgentRuntimeProviderConfig;
}>;
export type UsageWindow = Readonly<{
  usedPercent?: number;
  status?: "available" | "rate-limited";
  windowDurationMinutes: number;
  resetsAt: string;
}>;
export type UsageSnapshot = Readonly<{
  provider: RuntimeProvider;
  planType?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: Readonly<{ hasCredits: boolean; unlimited: boolean }>;
}>;
export type AgentSessionOptions = Readonly<{
  agentId?: string;
  runtimeId?: string;
  agentWorkspaceDirectory: string;
  sessionId?: string;
  runtime?: AgentRuntimeConfig;
  environment?: Readonly<Record<string, string>>;
}>;
export type AgentRuntimeEvent =
  | { type: "activity"; activity: AgentActivity }
  | { type: "usage"; snapshot: UsageSnapshot }
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-output"; id: string; text: string }
  | { type: "tool-end"; id: string; isError: boolean }
  | { type: "completed"; status: "completed" | "interrupted" | "failed" };
export interface AgentSession {
  sendMessage(message: string): Promise<void>;
  notify?(notice: string): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
  interrupt(): Promise<void>;
  onExit(listener: () => void): () => void;
  dispose(): Promise<void>;
}
export interface AgentDriver {
  readonly provider: RuntimeProvider;
  createAgentSession(options: AgentSessionOptions): Promise<AgentSession>;
  readUsage?(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null>;
}
export type AgentDriverFactory = (provider: RuntimeProvider) => AgentDriver;
