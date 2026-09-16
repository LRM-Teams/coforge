import type {
  CodeAgentModelCatalog,
  RuntimeMetadata,
  RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
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
export const AGENT_RUNTIME_EVENT_TYPE = { USAGE: "usage" } as const;
/** The account is authenticated but its quota cannot be represented safely. */
export class UsageUnavailableError extends Error {
  constructor() {
    super("Provider usage is unavailable");
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
