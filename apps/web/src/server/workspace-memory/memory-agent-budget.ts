/**
 * Web-route Memory Agent budget. Consumes the C2 constants that A1 uses;
 * does not copy the numeric limits.
 */

import {
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  MEMORY_READ_BUDGET_PER_TRIGGER,
  OPENVIKING_CANDIDATE_LIMIT_MAX,
  type OpenVikingAgentCommand,
} from "@lrm/coforge-sdk/agent";

const MEMORY_READ_OPS = new Set(["find", "search_context", "read"]);

export class MemoryAgentBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryAgentBudgetError";
  }
}

/** Per-triggering-message budget. Same limits as A1's MemoryAgentTurnBudget. */
export class MemoryAgentTriggerBudget {
  #reads = 0;
  #offers = 0;

  consume(command: OpenVikingAgentCommand): void {
    if (MEMORY_READ_OPS.has(command.op)) {
      if (this.#reads >= MEMORY_READ_BUDGET_PER_TRIGGER)
        throw new MemoryAgentBudgetError(
          "memory read budget exhausted for this triggering message",
        );
      const limit = "limit" in command ? command.limit : undefined;
      if (limit !== undefined && limit > OPENVIKING_CANDIDATE_LIMIT_MAX)
        throw new MemoryAgentBudgetError("candidate limit exceeded");
      this.#reads += 1;
      return;
    }
    if (command.op === "offer") {
      if (this.#offers >= MEMORY_OFFER_BUDGET_PER_TRIGGER)
        throw new MemoryAgentBudgetError(
          "memory offer budget exhausted for this triggering message",
        );
      this.#offers += 1;
    }
  }

  snapshot() {
    return { reads: this.#reads, offers: this.#offers };
  }
}

export type MemoryAgentBudgetLedger = {
  forTrigger(input: {
    workspaceId: string;
    agentId: string;
    triggerMessageId: string;
  }): MemoryAgentTriggerBudget;
};

export function createMemoryAgentBudgetLedger(): MemoryAgentBudgetLedger {
  const budgets = new Map<string, MemoryAgentTriggerBudget>();
  return {
    forTrigger({ workspaceId, agentId, triggerMessageId }) {
      const key = `${workspaceId}:${agentId}:${triggerMessageId}`;
      const existing = budgets.get(key);
      if (existing) return existing;
      const created = new MemoryAgentTriggerBudget();
      budgets.set(key, created);
      return created;
    },
  };
}
