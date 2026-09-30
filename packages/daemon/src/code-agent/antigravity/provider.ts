import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { type CodeAgentProvider, type ProviderDiscoveryOptions } from "#src/code-agent/contract";
import { createPerTurnSession } from "#src/code-agent/per-turn/session";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { discoverAntigravityCatalog } from "./catalog";
import { readAntigravityUsage } from "./usage";
import { createAntigravityTurnProtocol } from "./turn-protocol";
import { assertAntigravityVersionSupported } from "./version";

/**
 * Google's Antigravity CLI (`agy`) is a per-turn provider: `antigravity/turn-protocol.ts` says how
 * one turn is launched and read, and `createPerTurnSession` runs the session around it. This class
 * keeps discovery, the model catalog, usage and the version gate.
 */
export class AntigravityProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.ANTIGRAVITY;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["agy"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.ANTIGRAVITY,
      )
    )[0];
  }

  async discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverAntigravityCatalog(
      options.command ?? [...this.#command, "models"],
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
  }

  async readUsage(options: { workingDirectory: string; timeoutMs?: number }) {
    return readAntigravityUsage(options.workingDirectory, {
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertAntigravityVersionSupported(this.#command);
    return createPerTurnSession(createAntigravityTurnProtocol(options, this.#command), options);
  }
}
