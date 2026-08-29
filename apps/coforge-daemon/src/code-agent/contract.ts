import type { AgentActivity } from "../agent-runtime/agent-activity";
import type { RuntimeProvider } from "@coforge/protocol";

/** Provider-neutral seam owned by the daemon's Agent runtime manager. */
export type CodeAgentProvider = RuntimeProvider;

export type AgentRuntimeConfig = Readonly<{
  provider: CodeAgentProvider;
  model: string;
  reasoning: string;
}>;

export type AgentRuntimeEvent =
  | { type: "activity"; activity: AgentActivity }
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-output"; id: string; text: string }
  | { type: "tool-end"; id: string; isError: boolean }
  | { type: "completed"; status: "completed" | "interrupted" | "failed" };

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
  agentWorkspaceDirectory: string;
  /** Existing provider session to resume; adapters own provider-specific semantics. */
  sessionId?: string;
  runtime?: AgentRuntimeConfig;
  environment?: Readonly<Record<string, string>>;
}

export interface CodeAgentAdapter {
  readonly provider: CodeAgentProvider;
  start(options: CodeAgentStartOptions): Promise<CodeAgentSession>;
}
