import type { AgentActivity } from "../agent-runtime/agent-activity";

/** Provider-neutral seam owned by each workspace worker. */
export type CodeAgentProvider = "pi" | "codex" | "claude-code";

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
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
  interrupt(): Promise<void>;
  onExit(listener: () => void): () => void;
  dispose(): Promise<void>;
}

export interface CodeAgentStartOptions {
  agentWorkspaceDirectory: string;
  runtime?: AgentRuntimeConfig;
  environment?: Readonly<Record<string, string>>;
}

export interface CodeAgentAdapter {
  readonly provider: CodeAgentProvider;
  start(options: CodeAgentStartOptions): Promise<CodeAgentSession>;
}
