import type {
  AgentContextReport,
  CodeAgentModelCatalog,
  RuntimeMetadata,
  RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
export type { AgentContextReport } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions, UsageSnapshot } from "@coforge/agent";
export type {
  AgentActivity,
  AgentActivityLevel,
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentRuntimeProviderConfig,
  AgentSession,
  AgentSessionOptions,
} from "@coforge/agent";
export type { UsageSnapshot, UsageWindow } from "@coforge/agent";
export interface CodeAgentProvider {
  readonly provider: RuntimeProvider;
  createAgentSession(options: AgentSessionOptions): Promise<AgentSession>;
  discoverRuntime?(options?: ProviderDiscoveryOptions): Promise<RuntimeMetadata | undefined>;
  discoverModelCatalog?(
    options?: ProviderDiscoveryOptions,
  ): Promise<CodeAgentModelCatalog | undefined>;
  readUsage?(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null>;
  /**
   * Reads a one-shot breakdown of the Agent's current context-window composition,
   * against the Agent's own already-running native session — never a fresh one. `undefined` means
   * "ran, but no report could be made of it" (the caller reports this as `unparsed`), matching
   * `readUsage`'s own `null`-means-no-signal convention. Only the Claude Code provider implements
   * this today; a provider with no equivalent signal never offers it.
   */
  readContextReport?(options: {
    workingDirectory: string;
    sessionId: string;
    timeoutMs?: number;
  }): Promise<AgentContextReport | undefined>;
}
export type CodeAgentProviderFactory = (provider: RuntimeProvider) => CodeAgentProvider;
export type ProviderDiscoveryOptions = Readonly<{
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  command?: readonly string[];
  probe?: CodeAgentProbe;
}>;
export interface CodeAgentProbe {
  which(name: string, searchPath?: string): string | undefined;
  spawn(executable: string): {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill?(): void;
  };
  probe?(provider: RuntimeProvider, executable: string): Promise<string | undefined>;
  resolve?(
    provider: RuntimeProvider,
    name: string,
    searchPath?: string,
  ): string | undefined | Promise<string | undefined>;
}
export const AGENT_RUNTIME_EVENT_TYPE = {
  USAGE: "usage",
  // A provider-observed context-window reading, distinct from the plan-usage
  // `USAGE` event above. Claude Code only today; a provider with no such signal never emits it.
  CONTEXT_USAGE: "context-usage",
} as const;
/** The account is authenticated but its quota cannot be represented safely. */
export class UsageUnavailableError extends Error {
  constructor() {
    super("Provider usage is unavailable");
  }
}
/** The signed-in account has no plan usage to scan at all (Raft-aligned: a Codex API-key or
 * Bedrock account, or `requiresOpenaiAuth === false`, has no rate-limit windows) — mapped to
 * the `unsupported` scan status like Pi's static answer, not a misleading empty reading. */
export class UsageUnsupportedError extends Error {
  constructor() {
    super("Usage scanning is unsupported for this account");
  }
}

/** A `readContextReport` call did not finish before its timeout; the caller reports
 * this as `timeout`, distinct from `unparsed` (ran, produced nothing parseable) or a generic
 * `error` (the CLI itself failed). */
export class AgentContextReportTimeoutError extends Error {
  constructor() {
    super("Context scan timed out");
  }
}

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
