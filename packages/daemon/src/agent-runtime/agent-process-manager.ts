import { AgentStateMachine, type AgentStatus } from "./agent-state-machine";
import type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  CodeAgentProvider,
  CodeAgentSession,
} from "../code-agent/contract";
import { AgentProcessCleanupError } from "../code-agent/contract";
import { mkdir } from "node:fs/promises";

export type { AgentStatus } from "./agent-state-machine";

export type AgentRuntime = Readonly<{
  config: AgentRuntimeConfig;
  session: CodeAgentSession;
}>;

export type AgentAdapterFactory = (provider: CodeAgentProvider) => CodeAgentAdapter;
/** Owns all Agent runtime processes for the daemon's single Workspace. */
export class AgentProcessManager {
  readonly #createAdapter: AgentAdapterFactory;
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #states = new Map<string, AgentStateMachine>();
  readonly #stopping = new Set<string>();

  constructor(createAdapter: AgentAdapterFactory) {
    this.#createAdapter = createAdapter;
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
  ): Promise<AgentRuntime> {
    if (this.#stopping.has(agentId)) {
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    }
    if (this.#runtimes.has(agentId)) {
      throw new Error(`Agent runtime is already online: ${agentId}`);
    }
    await mkdir(agentWorkspaceDirectory, { recursive: true, mode: 0o700 });
    let session: CodeAgentSession;
    try {
      session = await this.#createAdapter(config.provider).start({
        agentWorkspaceDirectory,
        sessionId,
        runtime: config,
        environment,
      });
    } catch (error) {
      if (error instanceof AgentProcessCleanupError) this.#stopping.add(agentId);
      throw error;
    }
    const runtime: AgentRuntime = Object.freeze({ config: retainedRuntimeConfig(config), session });
    this.#stateFor(agentId).transition("runtime_ready");
    this.#runtimes.set(agentId, runtime);
    session.onExit(() => {
      if (this.#runtimes.get(agentId)?.session !== session) return;
      if (this.#stopping.has(agentId)) return;
      this.#runtimes.delete(agentId);
      this.#stateFor(agentId).transition("runtime_stopped");
    });
    return runtime;
  }

  async stop(agentId: string): Promise<void> {
    if (this.#stopping.has(agentId)) throw new Error(`Agent runtime is stopping: ${agentId}`);
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) return;
    this.#stopping.add(agentId);
    await runtime.session.dispose();
    if (this.#runtimes.get(agentId)?.session === runtime.session) this.#runtimes.delete(agentId);
    this.#stopping.delete(agentId);
    this.#stateFor(agentId).transition("runtime_stopped");
  }

  session(agentId: string): CodeAgentSession | undefined {
    const runtime = this.#runtimes.get(agentId);
    return runtime?.session;
  }

  isStopping(agentId: string): boolean {
    return this.#stopping.has(agentId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((agentId) => this.stop(agentId)));
  }

  #stateFor(agentId: string): AgentStateMachine {
    const existing = this.#states.get(agentId);
    if (existing) return existing;
    const machine = new AgentStateMachine();
    this.#states.set(agentId, machine);
    return machine;
  }
}

function retainedRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  const providerConfig = config.providerConfig;
  if (providerConfig?.kind !== "pi-builtin" || !providerConfig.apiKey) return config;
  const { apiKey: _apiKey, ...retainedProviderConfig } = providerConfig;
  return { ...config, providerConfig: retainedProviderConfig };
}
