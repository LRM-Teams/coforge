export type AgentRuntimeHandle = Readonly<{
  id: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
}>;

/** A daemon-owned, in-memory pool shared by all Workspace Workers. */
export class AgentRuntimePool {
  readonly #capacity: number;
  readonly #handles = new Map<string, AgentRuntimeHandle>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Agent runtime pool capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#handles.size;
  }

  acquire(
    workspaceId: string,
    computerId: string,
    agentId: string,
  ): AgentRuntimeHandle | undefined {
    if (this.#handles.size >= this.#capacity) return undefined;

    const handle: AgentRuntimeHandle = Object.freeze({
      id: crypto.randomUUID(),
      workspaceId,
      computerId,
      agentId,
    });
    this.#handles.set(handle.id, handle);
    return handle;
  }

  release(id: string): boolean {
    return this.#handles.delete(id);
  }
}
