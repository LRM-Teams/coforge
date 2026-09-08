import type { RuntimeProvider, ActivityTrajectoryEntry, ActivitySubagent } from "@coforge/protocol";

export type AgentActivityType =
  | "model_request_started"
  | "model_response_started"
  | "thinking_started"
  | "freshness_hold"
  | "starting"
  | "stopped"
  | "idle"
  | "running_command"
  | "tool_started"
  | "runtime_error"
  | "warning";
export type AgentActivityLevel = "info" | "warning" | "error";
export type AgentActivity = Readonly<{
  detailKind: AgentActivityType;
  level: AgentActivityLevel;
  detail: string;
  observedAtMs: number;
  entries?: ActivityTrajectoryEntry[];
  runtimeError?: Readonly<{ errorClass: string; errorReason: string; fingerprint: string }>;
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
  instructions: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  /** Acknowledged cloud persistence of the provider's actual session identity. */
  onSessionId?(sessionId: string, replacedSessionId?: string): Promise<void>;
  runtime?: AgentRuntimeConfig;
  environment?: Readonly<Record<string, string>>;
}>;
export type AgentRuntimeEvent =
  | { type: "activity"; activity: AgentActivity }
  | { type: "usage"; snapshot: UsageSnapshot }
  | { type: "text-delta" | "thinking-delta"; text: string; subagent?: ActivitySubagent }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-output"; id: string; text: string }
  | { type: "tool-end"; id: string; isError: boolean }
  | { type: "completed"; status: "completed" | "interrupted" | "failed" };
export interface AgentSession {
  sendMessage(message: string): Promise<void>;
  /**
   * Accept a notification in this session, including while work is in progress.
   * Resolve at the adapter's delivery boundary, not after the whole run.
   * Claude uses boundary-gated stdin write success; SDK/RPC adapters wait for
   * native acceptance. Neither guarantees model processing or a reply.
   * Reject failed delivery without ending an otherwise active run.
   * Adapters own native steering/queued-input protocols; callers own retry/ACK.
   */
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
