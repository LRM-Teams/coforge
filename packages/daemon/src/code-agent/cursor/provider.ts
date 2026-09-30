import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { type CodeAgentProvider, type ProviderDiscoveryOptions } from "#src/code-agent/contract";
import { createPerTurnSession } from "#src/code-agent/per-turn/session";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { discoverCursorCatalog } from "./catalog";
import { createCursorTurnProtocol } from "./turn-protocol";

/**
 * Cursor CLI (`cursor-agent`) is a per-turn provider: `cursor/turn-protocol.ts` says how one turn
 * is launched and read, and `createPerTurnSession` runs the session around it. This class keeps
 * discovery and the model catalog.
 */
export class CursorProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CURSOR;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["cursor-agent"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.CURSOR,
      )
    )[0];
  }

  async discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverCursorCatalog(
      options.command ?? [...this.#command, "models"],
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    return createPerTurnSession(createCursorTurnProtocol(options, this.#command), options);
  }
}
