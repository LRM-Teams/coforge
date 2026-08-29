import { AgentStateMachine, type AgentStatus } from "./agent-state-machine";
import type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  CodeAgentProvider,
  CodeAgentSession,
} from "../code-agent/contract";

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
    if (this.#runtimes.has(agentId)) {
      throw new Error(`Agent runtime is already online: ${agentId}`);
    }
    const session = await this.#createAdapter(config.provider).start({
      agentWorkspaceDirectory,
      sessionId,
      runtime: config,
      environment,
    });
    const runtime: AgentRuntime = Object.freeze({ config, session });
    this.#stateFor(agentId).transition("runtime_ready");
    this.#runtimes.set(agentId, runtime);
    session.onExit(() => {
      if (this.#runtimes.get(agentId)?.session !== session) return;
      this.#runtimes.delete(agentId);
      this.#stateFor(agentId).transition("runtime_stopped");
    });
    return runtime;
  }

  async stop(agentId: string): Promise<void> {
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) return;
    this.#runtimes.delete(agentId);
    try {
      await runtime.session.dispose();
    } finally {
      this.#stateFor(agentId).transition("runtime_stopped");
    }
  }

  session(agentId: string): CodeAgentSession | undefined {
    const runtime = this.#runtimes.get(agentId);
    return runtime?.session;
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
