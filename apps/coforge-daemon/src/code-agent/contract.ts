/** Provider-neutral seam owned by each workspace worker. */
export type CodeAgentProvider = "pi" | "codex";

export type CodeAgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-output"; id: string; text: string }
  | { type: "tool-end"; id: string; isError: boolean }
  | { type: "completed"; status: "completed" | "interrupted" | "failed" };

export interface CodeAgentSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: CodeAgentEvent) => void): () => void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CodeAgentStartOptions {
  agentWorkspaceDirectory: string;
  environment?: Readonly<Record<string, string>>;
}

export interface CodeAgentAdapter {
  readonly provider: CodeAgentProvider;
  start(options: CodeAgentStartOptions): Promise<CodeAgentSession>;
}
