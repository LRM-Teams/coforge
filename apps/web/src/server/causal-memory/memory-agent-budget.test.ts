import { expect, test } from "bun:test";
import {
  CAUSAL_AGENT_PROTOCOL,
  CAUSAL_OPENVIKING_TOOL_PROFILE,
  CAUSAL_SHARED_TOKEN_BUDGET,
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  MEMORY_READ_BUDGET_PER_TRIGGER,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_PROFILE,
} from "@lrm/coforge-sdk/agent";
import {
  createMemoryAgentBudgetLedger,
  MemoryAgentBudgetError,
  MemoryAgentTriggerBudget,
} from "./memory-agent-budget";

const ovFind = {
  protocol: OPENVIKING_AGENT_PROTOCOL,
  op: "find" as const,
  operationId: "f1",
  query: "deploy",
};

const causalSearch = {
  protocol: CAUSAL_AGENT_PROTOCOL,
  op: "search" as const,
  operationId: "s1",
  query: "deploy",
};

const offer = {
  protocol: OPENVIKING_AGENT_PROTOCOL,
  op: "offer" as const,
  operationId: "o1",
  conversationId: "c",
  targetAgentId: "a",
  recipientRationale: "owns the task",
  citationRefs: ["ov:1"],
  body: "cited offer",
};

test("Web budget consumes C2 constants rather than copied literals", () => {
  expect(MEMORY_READ_BUDGET_PER_TRIGGER).toBe(3);
  expect(MEMORY_OFFER_BUDGET_PER_TRIGGER).toBe(1);
  expect(CAUSAL_SHARED_TOKEN_BUDGET).toBe(4800);
});

test("both profiles reject a fourth read and a second Offer", () => {
  const openviking = new MemoryAgentTriggerBudget();
  openviking.consume(ovFind);
  openviking.consume({ ...ovFind, operationId: "f2" });
  openviking.consume({ ...ovFind, operationId: "f3" });
  expect(() => openviking.consume({ ...ovFind, operationId: "f4" })).toThrow(
    MemoryAgentBudgetError,
  );

  const mixed = new MemoryAgentTriggerBudget();
  mixed.consume(causalSearch);
  mixed.consume({ ...causalSearch, operationId: "s2" });
  mixed.consume(ovFind);
  expect(() => mixed.consume({ ...ovFind, operationId: "f2" })).toThrow(MemoryAgentBudgetError);

  const offers = new MemoryAgentTriggerBudget();
  offers.consume(offer);
  expect(() => offers.consume({ ...offer, operationId: "o2" })).toThrow(MemoryAgentBudgetError);
});

test("shared 4800 token budget matches A1 allocation and exhaustion", () => {
  const budget = new MemoryAgentTriggerBudget();
  expect(budget.consume(causalSearch)).toBe(1600);
  expect(budget.consume({ ...causalSearch, operationId: "s2", tokenBudget: 2400 })).toBe(2400);
  expect(budget.consume({ ...causalSearch, operationId: "s3" })).toBe(800);
  expect(budget.snapshot()).toEqual({
    reads: 3,
    offers: 0,
    tokensUsed: 4800,
    tokensRemaining: 0,
  });

  const exhausted = new MemoryAgentTriggerBudget();
  exhausted.consume({ ...causalSearch, tokenBudget: 2400 });
  exhausted.consume({ ...causalSearch, operationId: "s2", tokenBudget: 2400 });
  expect(() => exhausted.consume({ ...causalSearch, operationId: "s3" })).toThrow(
    MemoryAgentBudgetError,
  );
});

test("openviking-memory search_context is not charged against the 4800 causal token pool", () => {
  const budget = new MemoryAgentTriggerBudget();
  const searchContext = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "search_context" as const,
    operationId: "c1",
    query: "deploy",
    tokenBudget: 8000,
  };
  expect(budget.consume(searchContext, OPENVIKING_TOOL_PROFILE)).toBeUndefined();
  expect(budget.snapshot()).toEqual({
    reads: 1,
    offers: 0,
    tokensUsed: 0,
    tokensRemaining: 4800,
  });
  budget.consume({ ...searchContext, operationId: "c2" }, OPENVIKING_TOOL_PROFILE);
  budget.consume({ ...searchContext, operationId: "c3" }, OPENVIKING_TOOL_PROFILE);
  expect(() =>
    budget.consume({ ...searchContext, operationId: "c4" }, OPENVIKING_TOOL_PROFILE),
  ).toThrow(MemoryAgentBudgetError);
});

test("causal-openviking-memory search_context still uses the shared causal token budget", () => {
  const budget = new MemoryAgentTriggerBudget();
  expect(
    budget.consume(
      {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "search_context",
        operationId: "c1",
        query: "deploy",
        tokenBudget: 2400,
      },
      CAUSAL_OPENVIKING_TOOL_PROFILE,
    ),
  ).toBe(2400);
  expect(budget.snapshot().tokensRemaining).toBe(2400);
});

test("ledger isolates budget by Workspace, Memory Agent, and triggering Message", () => {
  const ledger = createMemoryAgentBudgetLedger();
  const first = ledger.forTrigger({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
  });
  first.consume(ovFind);
  first.consume(offer);
  const same = ledger.forTrigger({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
  });
  expect(() => same.consume({ ...offer, operationId: "o2" })).toThrow(MemoryAgentBudgetError);
  const nextTrigger = ledger.forTrigger({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-2",
  });
  expect(nextTrigger.consume({ ...ovFind, operationId: "f-next" })).toBeUndefined();
  expect(nextTrigger.consume({ ...offer, operationId: "o-next" })).toBeUndefined();
});
