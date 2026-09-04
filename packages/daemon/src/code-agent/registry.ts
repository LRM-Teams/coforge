import { ClaudeCodeDriver } from "./claude-code/driver";
import { CodexDriver } from "./codex/driver";
import type { AgentDriver, CodeAgentProvider } from "./contract";
import { CoforgeDriver, PiDriver } from "./pi/driver";
import { RUNTIME_PROVIDER } from "@coforge/protocol";

export function createAgentDriver(provider: CodeAgentProvider): AgentDriver {
  switch (provider) {
    case RUNTIME_PROVIDER.COFORGE:
      return new CoforgeDriver();
    case RUNTIME_PROVIDER.PI:
      return new PiDriver();
    case RUNTIME_PROVIDER.CODEX:
      return new CodexDriver();
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeCodeDriver();
  }
}
