import { expect, test } from "bun:test";
import {
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  MEMORY_READ_BUDGET_PER_TRIGGER,
  OPENVIKING_AGENT_PROTOCOL,
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
});

test("rejects a fourth read and a second Offer", () => {
  const openviking = new MemoryAgentTriggerBudget();
  openviking.consume(ovFind);
  openviking.consume({ ...ovFind, operationId: "f2" });
  openviking.consume({ ...ovFind, operationId: "f3" });
  expect(() => openviking.consume({ ...ovFind, operationId: "f4" })).toThrow(
    MemoryAgentBudgetError,
  );

  const offers = new MemoryAgentTriggerBudget();
  offers.consume(offer);
  expect(() => offers.consume({ ...offer, operationId: "o2" })).toThrow(MemoryAgentBudgetError);
});

test("search_context consumes the read budget and carries no token pool", () => {
  const budget = new MemoryAgentTriggerBudget();
  const searchContext = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "search_context" as const,
    operationId: "c1",
    query: "deploy",
    tokenBudget: 8000,
  };
  expect(budget.consume(searchContext)).toBeUndefined();
  expect(budget.snapshot()).toEqual({ reads: 1, offers: 0 });
  budget.consume({ ...searchContext, operationId: "c2" });
  budget.consume({ ...searchContext, operationId: "c3" });
  expect(() => budget.consume({ ...searchContext, operationId: "c4" })).toThrow(
    MemoryAgentBudgetError,
  );
  expect(budget.snapshot()).toEqual({ reads: 3, offers: 0 });
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
