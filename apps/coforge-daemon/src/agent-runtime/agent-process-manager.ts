import type { AgentRuntimeHandle } from "../agent-capacity/agent-runtime-pool";
import { AgentRuntimePool } from "../agent-capacity/agent-runtime-pool";
import { AgentStateMachine, type AgentStatus } from "./agent-state-machine";
import type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  CodeAgentProvider,
  CodeAgentSession,
} from "../code-agent/contract";

export type { AgentStatus } from "./agent-state-machine";

export type AgentRuntime = Readonly<{
  handle: AgentRuntimeHandle;
  config: AgentRuntimeConfig;
  session: CodeAgentSession;
}>;

export type AgentAdapterFactory = (provider: CodeAgentProvider) => CodeAgentAdapter;
/** Owns the Agent runtime processes for exactly one workspace worker. */
export class AgentProcessManager {
  readonly #pool: AgentRuntimePool;
  readonly #workspaceId: string;
  readonly #computerId: string;
  readonly #createAdapter: AgentAdapterFactory;
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #states = new Map<string, AgentStateMachine>();

  constructor(
    pool: AgentRuntimePool,
    workspaceId: string,
    computerId: string,
    createAdapter: AgentAdapterFactory,
  ) {
    this.#pool = pool;
    this.#workspaceId = workspaceId;
    this.#computerId = computerId;
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
  ): Promise<AgentRuntime> {
    if (this.#runtimes.has(agentId)) {
      throw new Error(`Agent runtime is already online: ${agentId}`);
    }
    const handle = this.#pool.acquire(this.#workspaceId, this.#computerId, agentId);
    if (!handle) throw new Error("Agent runtime capacity is full");

    try {
      const session = await this.#createAdapter(config.provider).start({
        agentWorkspaceDirectory,
        runtime: config,
      });
      const runtime: AgentRuntime = Object.freeze({ handle, config, session });
      this.#stateFor(agentId).transition("runtime_ready");
      this.#runtimes.set(agentId, runtime);
      session.onExit(() => {
        if (this.#runtimes.get(agentId)?.handle.id !== handle.id) return;
        this.#runtimes.delete(agentId);
        this.#stateFor(agentId).transition("runtime_stopped");
        this.#pool.release(handle.id);
      });
      return runtime;
    } catch (error) {
      this.#pool.release(handle.id);
      throw error;
    }
  }

  async stop(agentId: string): Promise<void> {
    const runtime = this.#runtimes.get(agentId);
    if (!runtime) return;
    this.#runtimes.delete(agentId);
    try {
      await runtime.session.dispose();
    } finally {
      this.#stateFor(agentId).transition("runtime_stopped");
      this.#pool.release(runtime.handle.id);
    }
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
