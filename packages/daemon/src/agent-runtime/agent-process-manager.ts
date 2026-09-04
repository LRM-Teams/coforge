import { AgentStateMachine, type AgentStatus } from "./agent-state-machine";
import type { AgentDriverFactory, AgentRuntimeConfig, AgentSession } from "@coforge/agent";
import { AgentProcessCleanupError } from "../code-agent/contract";
import { mkdir } from "node:fs/promises";

export type { AgentStatus } from "./agent-state-machine";

export type AgentRuntime = Readonly<{
  config: AgentRuntimeConfig;
  session: AgentSession;
}>;

export type AgentRestartConfig = Readonly<{
  config: AgentRuntimeConfig;
  sessionId: string | undefined;
}>;

export type { AgentDriverFactory } from "@coforge/agent";
/** Owns Agent availability and runtime processes for the daemon's single Workspace. */
export class AgentProcessManager {
  readonly #createDriver: AgentDriverFactory;
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #restartConfigs = new Map<string, AgentRestartConfig>();
  readonly #states = new Map<string, AgentStateMachine>();
  readonly #stopping = new Set<string>();

  constructor(createDriver: AgentDriverFactory) {
    this.#createDriver = createDriver;
  }

  get size(): number {
    return this.#runtimes.size;
  }

  status(agentId: string): AgentStatus {
    return this.#stateFor(agentId).state;
  }

  async start(
    agentId: string,
    config: AgentRuntimeConfig,
    agentWorkspaceDirectory: string,
    sessionId?: string,
    environment?: Readonly<Record<string, string>>,
    runtimeId?: string,
  ): Promise<AgentRuntime> {
    if (this.#stopping.has(agentId)) {
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    }
    if (this.#runtimes.has(agentId)) {
      throw new Error(`Agent runtime is already active: ${agentId}`);
    }
    await mkdir(agentWorkspaceDirectory, { recursive: true, mode: 0o700 });
    let session: AgentSession;
    try {
      session = await this.#createDriver(config.provider).createAgentSession({
        agentId,
        ...(runtimeId ? { runtimeId } : {}),
        agentWorkspaceDirectory,
        sessionId,
        runtime: config,
        environment,
      });
    } catch (error) {
      if (error instanceof AgentProcessCleanupError) this.#stopping.add(agentId);
      throw error;
    }
    const runtime: AgentRuntime = Object.freeze({ config, session });
    this.#restartConfigs.set(agentId, { config, sessionId });
    this.#stateFor(agentId).transition("runtime_ready");
    this.#runtimes.set(agentId, runtime);
    session.onExit(() => {
      if (this.#runtimes.get(agentId)?.session !== session) return;
      if (this.#stopping.has(agentId)) return;
      this.#runtimes.delete(agentId);
      this.#stateFor(agentId).transition("runtime_released");
    });
    return runtime;
  }

  async stop(agentId: string): Promise<void> {
    if (this.#stopping.has(agentId)) throw new Error(`Agent runtime is stopping: ${agentId}`);
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) {
      this.#restartConfigs.delete(agentId);
      this.#stateFor(agentId).transition("deactivate");
      return;
    }
    this.#stopping.add(agentId);
    await runtime.session.dispose();
    if (this.#runtimes.get(agentId)?.session === runtime.session) this.#runtimes.delete(agentId);
    this.#stopping.delete(agentId);
    this.#restartConfigs.delete(agentId);
    this.#stateFor(agentId).transition("deactivate");
  }

  session(agentId: string): AgentSession | undefined {
    const runtime = this.#runtimes.get(agentId);
    return runtime?.session;
  }

  restartConfig(agentId: string): AgentRestartConfig | undefined {
    return this.#restartConfigs.get(agentId);
  }

  activeAgentIds(): string[] {
    return [...this.#restartConfigs.keys()];
  }

  isStopping(agentId: string): boolean {
    return this.#stopping.has(agentId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((agentId) => this.stop(agentId)));
    this.#restartConfigs.clear();
    for (const state of this.#states.values()) state.transition("deactivate");
  }

  #stateFor(agentId: string): AgentStateMachine {
    const existing = this.#states.get(agentId);
    if (existing) return existing;
    const machine = new AgentStateMachine();
    this.#states.set(agentId, machine);
    return machine;
  }
}
