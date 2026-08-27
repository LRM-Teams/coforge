import { ClaudeCodeAgentAdapter } from "./claude-code/adapter";
import { CodexAgentAdapter } from "./codex/adapter";
import type { CodeAgentAdapter, CodeAgentProvider } from "./contract";
import { PiAgentAdapter } from "./pi/adapter";

export function createCodeAgentAdapter(provider: CodeAgentProvider): CodeAgentAdapter {
  switch (provider) {
    case "pi":
      return new PiAgentAdapter();
    case "codex":
      return new CodexAgentAdapter();
    case "claude-code":
      return new ClaudeCodeAgentAdapter();
  }
}
