export type AgentStatus = "online" | "offline";
export type AgentStateEvent = "runtime_ready" | "runtime_stopped";

export type AgentStateTransition =
  | { changed: false }
  | { changed: true; from: AgentStatus; to: AgentStatus };

/** Small finite state machine for the two externally visible Agent statuses. */
export class AgentStateMachine {
  #state: AgentStatus = "offline";

  get state(): AgentStatus {
    return this.#state;
  }

  transition(event: AgentStateEvent): AgentStateTransition {
    const next = event === "runtime_ready" ? "online" : "offline";
    if (next === this.#state) return { changed: false };
    const from = this.#state;
    this.#state = next;
    return { changed: true, from, to: next };
  }
}
