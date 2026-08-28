import { ClaudeCodeAgentAdapter } from "./claude-code/adapter";
import { CodexAgentAdapter } from "./codex/adapter";
import type { CodeAgentAdapter, CodeAgentProvider } from "./contract";
import { PiAgentAdapter } from "./pi/adapter";
import { RUNTIME_PROVIDER } from "@coforge/protocol";

export function createCodeAgentAdapter(provider: CodeAgentProvider): CodeAgentAdapter {
  switch (provider) {
    case RUNTIME_PROVIDER.PI:
      return new PiAgentAdapter();
    case RUNTIME_PROVIDER.CODEX:
      return new CodexAgentAdapter();
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeCodeAgentAdapter();
  }
}
