import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { type CodeAgentProvider, type ProviderDiscoveryOptions } from "#src/code-agent/contract";
import { createPerTurnSession } from "#src/code-agent/per-turn/session";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { discoverOpenCodeCatalog } from "./catalog";
import { createOpenCodeTurnProtocol } from "./turn-protocol";
import { assertOpenCodeVersionSupported } from "./version";

/**
 * OpenCode (`opencode`, SST) is a per-turn provider: `opencode/turn-protocol.ts` says how one turn
 * is launched and read, and `createPerTurnSession` runs the session around it. This class keeps
 * discovery, the model catalog and the version gate.
 */
export class OpenCodeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.OPENCODE;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["opencode"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.OPENCODE,
      )
    )[0];
  }

  async discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverOpenCodeCatalog(
      options.command ?? [...this.#command, "models"],
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertOpenCodeVersionSupported(this.#command);
    return createPerTurnSession(createOpenCodeTurnProtocol(options, this.#command), options);
  }
}
