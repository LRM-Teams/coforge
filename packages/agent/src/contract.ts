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
  /** When this snapshot was actually observed (ISO instant) — stamped centrally by
   * `DaemonRuntime.scanUsage`, never by an individual provider reader, so a snapshot reused from
   * a passively observed usage event carries the time it was observed rather than "now". Older
   * Computers omit it. */
  collectedAt?: string;
  /** The signed-in account, masked before it ever leaves the Computer (only the local part's
   * first characters survive, e.g. `me****@gmail.com`) — never the raw address. Populated only
   * for a provider whose existing usage/auth read already reports it. */
  accountLabel?: string;
}>;
export type AgentSessionIdentity = Readonly<{
  sessionId: string;
  state: "empty" | "resumable" | "unknown";
}>;
/** How a launch injects the commit co-author trailer hook into the Agent's git (ADR 0048):
 * `config-hook` for git >= 2.54's config-based hooks, `hooks-path` for an older git pointed at the
 * Daemon's forwarding shim directory. */
export type AgentGitHookPlan =
  | { readonly kind: "config-hook" }
  | { readonly kind: "hooks-path"; readonly hooksDir: string };
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
  /** Resolved once per launch by the Daemon; every process the session spawns reuses it. */
  gitHooks?: AgentGitHookPlan;
}>;
export type AgentSessionOptions = AgentSessionCommonOptions;
export type AgentRuntimeEvent =
  | { type: "activity"; activity: AgentActivity }
  | { type: "usage"; snapshot: UsageSnapshot }
  // A provider-observed context-window reading (ADR 0050), distinct from the plan-usage
  // `usage` event above. Claude Code reports this at the top-level `result` record; a
  // provider with no such signal never emits it.
  | { type: "context-usage"; usedTokens: number; windowTokens: number; occurredAt?: string }
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
  | { type: "progress"; source?: string; occurredAt?: string }
  /**
   * A provider-observed runtime failure, reported as raw facts only: the provider
   * never formats, truncates, or classifies this for display — the daemon core
   * owns all of that (single conversion in agent-runtime/runtime-error-activity.ts).
   * `providerErrorCode`/`providerErrorClass` are optional provider-native hints
   * (e.g. a JSON-RPC error code, a turn error's `code` field); `providerErrorReason`
   * is an optional stable category the provider already distinguishes (e.g. Codex's
   * "turn_failed" for a turn ending in failure, as opposed to a mid-stream RPC
   * error) — omit any of the three when the provider has no such fact. `retryable`
   * reflects a provider's own "will retry" signal, if it has one.
   */
  | {
      type: "error";
      message: string;
      retryable?: boolean;
      providerErrorCode?: string;
      providerErrorClass?: string;
      providerErrorReason?: string;
      occurredAt?: string;
    }
  /** The provider is reconnecting to its upstream after a transient disconnect. */
  | { type: "reconnecting"; attempt?: number; message?: string }
  /**
   * A steer-mode provider accepted a notice into the live turn (`notify` resolved), but later
   * learned it never actually reached the model — a native steer request the provider's own
   * turn-boundary protocol failed to admit, or a queued one its native buffer discarded before
   * injecting. `text` is the exact notice text `notify` was given; the daemon core is the only
   * one that decides whether and how to redeliver it (ADR 0048's daemon-owned delivery queue) —
   * the provider does not retry on its own and does not know about ACK/attention state.
   */
  | { type: "notice-undelivered"; text: string };
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
