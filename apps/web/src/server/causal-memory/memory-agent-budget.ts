/**
 * Web-route Memory Agent budget. Consumes the C2 constants that A1 uses;
 * does not copy the numeric limits.
 */

import {
  allocateCausalReadTokens,
  CAUSAL_CANDIDATE_LIMIT_MAX,
  CAUSAL_SHARED_TOKEN_BUDGET,
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  MEMORY_READ_BUDGET_PER_TRIGGER,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_PROFILE,
  type CausalAgentCommand,
  type MemoryAgentToolProfile,
  type OpenVikingAgentCommand,
} from "@lrm/coforge-sdk/agent";

const MEMORY_READ_OPS = new Set(["search", "trace", "intervene", "find", "search_context", "read"]);
const MEMORY_TOKEN_OPS = new Set(["search", "trace", "intervene", "search_context"]);

export class MemoryAgentBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryAgentBudgetError";
  }
}

/** Per-triggering-message shared budget. Same limits as A1's CausalMemoryTurnBudget. */
export class MemoryAgentTriggerBudget {
  #reads = 0;
  #offers = 0;
  #tokensRemaining: number = CAUSAL_SHARED_TOKEN_BUDGET;

  consume(
    command: CausalAgentCommand | OpenVikingAgentCommand,
    fence?: MemoryAgentToolProfile,
  ): number | undefined {
    if (MEMORY_READ_OPS.has(command.op)) {
      if (this.#reads >= MEMORY_READ_BUDGET_PER_TRIGGER)
        throw new MemoryAgentBudgetError(
          "memory read budget exhausted for this triggering message",
        );
      const limit = "limit" in command ? command.limit : undefined;
      if (limit !== undefined && limit > CAUSAL_CANDIDATE_LIMIT_MAX)
        throw new MemoryAgentBudgetError("candidate limit exceeded");
      let allocated: number | undefined;
      if (
        MEMORY_TOKEN_OPS.has(command.op) &&
        !isStandaloneOpenVikingSearchContext(command, fence)
      ) {
        try {
          const requestedTokens = "tokenBudget" in command ? command.tokenBudget : undefined;
          allocated = allocateCausalReadTokens({
            remainingTokens: this.#tokensRemaining,
            requestedTokens,
          });
        } catch (error) {
          throw new MemoryAgentBudgetError(
            error instanceof Error ? error.message : "memory token budget exhausted",
          );
        }
        this.#tokensRemaining -= allocated;
      }
      this.#reads += 1;
      return allocated;
    }
    if (command.op === "offer") {
      if (this.#offers >= MEMORY_OFFER_BUDGET_PER_TRIGGER)
        throw new MemoryAgentBudgetError(
          "memory offer budget exhausted for this triggering message",
        );
      this.#offers += 1;
    }
    return undefined;
  }

  snapshot() {
    return {
      reads: this.#reads,
      offers: this.#offers,
      tokensUsed: CAUSAL_SHARED_TOKEN_BUDGET - this.#tokensRemaining,
      tokensRemaining: this.#tokensRemaining,
    };
  }
}

export type MemoryAgentBudgetLedger = {
  forTrigger(input: {
    workspaceId: string;
    agentId: string;
    triggerMessageId: string;
  }): MemoryAgentTriggerBudget;
};

function isStandaloneOpenVikingSearchContext(
  command: CausalAgentCommand | OpenVikingAgentCommand,
  fence: MemoryAgentToolProfile | undefined,
): boolean {
  return (
    fence === OPENVIKING_TOOL_PROFILE &&
    command.protocol === OPENVIKING_AGENT_PROTOCOL &&
    command.op === "search_context"
  );
}

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
