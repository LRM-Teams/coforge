import { expect, test } from "bun:test";
import { CAUSAL_TOOL_NAMES, CAUSAL_TOOL_PROFILE } from "@lrm/coforge-sdk/agent";
import { CausalMemoryTurnBudget, createCausalMemoryTools } from "../src/runner";

test("the causal-memory fence exposes only causal and message tools", () => {
  const names = createCausalMemoryTools(new CausalMemoryTurnBudget()).map((tool) => tool.name);
  expect(names).toEqual([
    CAUSAL_TOOL_NAMES.search,
    CAUSAL_TOOL_NAMES.trace,
    CAUSAL_TOOL_NAMES.intervene,
    CAUSAL_TOOL_NAMES.offer,
    CAUSAL_TOOL_NAMES.proposeCorrection,
    "message_check",
    "message_read",
    "send_channel_message",
  ]);
  expect(names).not.toContain("bash");
  expect(CAUSAL_TOOL_PROFILE).toBe("causal-memory");
});

test("the turn budget stops a fourth causal read and a second offer", () => {
  const budget = new CausalMemoryTurnBudget();
  const read = {
    protocol: "coforge.causal.agent.v1" as const,
    op: "search" as const,
    operationId: "q1",
    query: "x",
  };
  budget.consume(read);
  budget.consume({ ...read, operationId: "q2" });
  budget.consume({ ...read, operationId: "q3" });
  expect(() => budget.consume({ ...read, operationId: "q4" })).toThrow("read budget");
  const offer = {
    protocol: "coforge.causal.agent.v1" as const,
    op: "offer" as const,
    operationId: "o1",
    conversationId: "c",
    targetAgentId: "a",
    recipientRationale: "owns the task",
    citationRefs: ["item:1"],
    body: "cited offer",
  };
  budget.consume(offer);
  expect(() => budget.consume({ ...offer, operationId: "o2" })).toThrow("offer budget");
});
