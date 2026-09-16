import { ClaudeCodeProvider } from "./claude-code/driver";
import { CodexProvider } from "./codex/driver";
import type { CodeAgentProvider } from "./contract";
import { CoforgeProvider, PiProvider } from "./pi/driver";
import { KiroProvider } from "./kiro/driver";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

export function createCodeAgentProvider(provider: RuntimeProvider): CodeAgentProvider {
  switch (provider) {
    case RUNTIME_PROVIDER.COFORGE:
      return new CoforgeProvider();
    case RUNTIME_PROVIDER.PI:
      return new PiProvider();
    case RUNTIME_PROVIDER.CODEX:
      return new CodexProvider();
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeCodeProvider();
    case RUNTIME_PROVIDER.KIRO:
      return new KiroProvider();
  }
}
