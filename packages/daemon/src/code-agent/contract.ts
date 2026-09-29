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
  AgentNoticeOptions,
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

/*
 * Typed launch failures. A provider throws one of these when it knows why a launch cannot start;
 * `code` is the launch failure reason `agent-runtime/launch-failure.ts` reports, so the layers
 * above never read provider-specific errors or message text. `RuntimeExecutableNotFoundError`
 * (`platform/runtime-executable-not-found.ts`) follows the same convention.
 */

/** The runtime's CLI is below the version CoForge supports; the launch is refused before spawn.
 * The message names the found and required versions and what to upgrade. */
export class RuntimeVersionUnsupportedError extends Error {
  readonly code = "runtime_version_too_old";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeVersionUnsupportedError";
  }
}

/** The runtime on this Computer does not offer the Agent's configured model. */
export class RuntimeModelNotFoundError extends Error {
  readonly code = "model_not_found";
  constructor(
    readonly model: string,
    options?: ErrorOptions,
  ) {
    super(`Model ${model} is not available to this runtime`, options);
    this.name = "RuntimeModelNotFoundError";
  }
}

/** The Agent's model provider setting cannot be used: missing, unconfigured, or not matching the
 * selected model. */
export class ModelProviderSettingError extends Error {
  readonly code = "model_provider_not_configured";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelProviderSettingError";
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
