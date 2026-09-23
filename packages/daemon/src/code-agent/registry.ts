import { ClaudeCodeProvider } from "./claude-code/provider";
import { CodexProvider } from "./codex/provider";
import type { CodeAgentProvider } from "./contract";
import { CursorProvider } from "./cursor/provider";
import { CoforgeProvider, PiProvider } from "./pi/provider";
import { KiroProvider } from "./kiro/provider";
import { GrokProvider } from "./grok/provider";
import { OpenCodeProvider } from "./opencode/provider";
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
    case RUNTIME_PROVIDER.CURSOR:
      return new CursorProvider();
    case RUNTIME_PROVIDER.OPENCODE:
      return new OpenCodeProvider();
    case RUNTIME_PROVIDER.GROK:
      return new GrokProvider();
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled runtime provider: ${unreachable}`);
    }
  }
}
