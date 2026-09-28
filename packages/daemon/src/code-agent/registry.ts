import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import { CodexProvider } from "#src/code-agent/codex/provider";
import type { CodeAgentProvider } from "./contract";
import { CursorProvider } from "#src/code-agent/cursor/provider";
import { CoforgeProvider, PiProvider } from "#src/code-agent/pi/provider";
import { KiroProvider } from "#src/code-agent/kiro/provider";
import { GrokProvider } from "#src/code-agent/grok/provider";
import { OpenCodeProvider } from "#src/code-agent/opencode/provider";
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
