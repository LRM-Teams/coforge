export type AgentStatus = "active" | "inactive";
export type AgentStateEvent =
  | "runtime_ready"
  | "runtime_released"
  | "runtime_stopped"
  | "deactivate";

export type AgentStateTransition =
  | { changed: false }
  | { changed: true; from: AgentStatus; to: AgentStatus };

/** Small finite state machine for the two externally visible Agent statuses. */
export class AgentStateMachine {
  #state: AgentStatus = "inactive";

  get state(): AgentStatus {
    return this.#state;
  }

  transition(event: AgentStateEvent): AgentStateTransition {
    const next = event === "deactivate" || event === "runtime_stopped" ? "inactive" : "active";
    if (next === this.#state) return { changed: false };
    const from = this.#state;
    this.#state = next;
    return { changed: true, from, to: next };
  }
}
