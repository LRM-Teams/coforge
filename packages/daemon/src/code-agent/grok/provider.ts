import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions, UsageSnapshot } from "@coforge/agent";
import { type CodeAgentProvider, type ProviderDiscoveryOptions } from "#src/code-agent/contract";
import { createPerTurnSession } from "#src/code-agent/per-turn/session";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { createGrokTurnProtocol } from "./turn-protocol";
import { assertGrokVersionSupported } from "./version";
import { readGrokUsage } from "./usage";

/**
 * Grok Build (`grok`, xAI) is a per-turn provider: `grok/turn-protocol.ts` says how one turn is
 * launched and read, and `createPerTurnSession` runs the session around it. This class keeps
 * discovery, usage and the version gate.
 */
export class GrokProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.GROK;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["grok"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.GROK,
      )
    )[0];
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readGrokUsage(options.workingDirectory, {
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertGrokVersionSupported(this.#command);
    return createPerTurnSession(createGrokTurnProtocol(options, this.#command), options);
  }
}
