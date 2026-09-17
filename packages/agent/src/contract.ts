import type {
  RuntimeProvider,
  ActivityTrajectoryEntry,
  ActivitySubagent,
  AgentActivityDetailKind,
} from "@lrm/coforge-sdk/internal";

export type AgentActivityLevel = "info" | "warning" | "error";
export type AgentActivity = Readonly<{
  detailKind: AgentActivityDetailKind;
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
  envVars?: Readonly<Record<string, string>>;
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
  /** Included credits consumed, included limit, and separately billed overage. */
  creditUsage?: Readonly<{ used: number; limit: number; overage: number }>;
}>;
export type AgentSessionIdentity = Readonly<{
  sessionId: string;
  state: "empty" | "resumable" | "unknown";
}>;
type AgentSessionCommonOptions = Readonly<{
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
export type AgentSessionOptions = AgentSessionCommonOptions;
export type AgentRuntimeEvent =
  | { type: "activity"; activity: AgentActivity }
  | { type: "usage"; snapshot: UsageSnapshot }
  | { type: "text-delta" | "thinking-delta"; text: string; subagent?: ActivitySubagent }
  | { type: "session"; identity: AgentSessionIdentity }
  | {
      type: "tool-start";
      id: string;
      name: string;
      /** The provider's raw tool arguments; the daemon core alone decides what Activity this is. */
      input?: unknown;
      subagent?: ActivitySubagent;
      /** The provider-reported event time; falls back to observation time if omitted. */
      occurredAt?: string;
    }
  | { type: "tool-output"; id: string; text: string }
  | { type: "tool-end"; id: string; isError: boolean }
  | { type: "completed"; status: "completed" | "interrupted" | "failed" }
  // Normalized signals a provider reports; the daemon core (not the provider) decides what
  // Activity, if any, each one becomes - see agent-runtime/compaction-tracker.ts and
  // agent-runtime/runtime-progress.ts.
  | { type: "compaction-started"; occurredAt?: string }
  | { type: "compaction-finished"; occurredAt?: string }
  // Only providers that can observe an aborted compaction report this (currently Pi/CoForge's
  // `compaction_end` with `aborted: true`); a provider with no such signal never emits it.
  | { type: "compaction-interrupted"; occurredAt?: string }
  // Content-free "the provider is alive" signal (e.g. a partial stream frame with no
  // renderable text, or a turn/message lifecycle notification that carries no content).
  | { type: "progress"; source?: string; occurredAt?: string };
export interface AgentSession {
  sendMessage(message: string): Promise<void>;
  readSessionIdentity?(): Promise<AgentSessionIdentity | undefined>;
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
