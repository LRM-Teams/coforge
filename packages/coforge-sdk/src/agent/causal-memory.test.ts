import { expect, test } from "bun:test";
import {
  CAUSAL_AGENT_ERROR_CODES,
  CAUSAL_AGENT_OPERATIONS,
  CAUSAL_AGENT_PROTOCOL,
  CAUSAL_OFFER_BUDGET_PER_TRIGGER,
  CAUSAL_READ_BUDGET_PER_TRIGGER,
  CAUSAL_TOOL_NAMES,
  CAUSAL_TOOL_PROFILE,
  decodeCausalAgentCommand,
  decodeCausalAgentResponse,
  isCausalAgentError,
  isCausalCitation,
  isCausalOperationId,
  type CausalCitation,
} from "./causal-memory";

const citation: CausalCitation = {
  citationId: "item:decision-1",
  causalItemId: "decision-1",
  admittedSegmentId: "segment-1",
  sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
  displayContent: "skipping tests caused a rollback",
};

test("freezes the agent causal protocol, profile, tools, and turn budget", () => {
  expect(CAUSAL_AGENT_PROTOCOL).toBe("coforge.causal.agent.v1");
  expect(CAUSAL_TOOL_PROFILE).toBe("causal-memory");
  expect(CAUSAL_TOOL_NAMES).toEqual({
    search: "causal_search",
    trace: "causal_trace",
    intervene: "causal_intervention",
    offer: "memory_offer",
    proposeCorrection: "causal_propose_correction",
  });
  expect(CAUSAL_AGENT_OPERATIONS).toEqual([
    "search",
    "trace",
    "intervene",
    "offer",
    "propose_correction",
  ]);
  expect(CAUSAL_READ_BUDGET_PER_TRIGGER).toBe(3);
  expect(CAUSAL_OFFER_BUDGET_PER_TRIGGER).toBe(1);
});

test("accepts a stable operation id and rejects questions or spaces", () => {
  expect(isCausalOperationId("closing-work-items")).toBe(true);
  expect(isCausalOperationId("A")).toBe(true);
  expect(isCausalOperationId("why did we skip tests?")).toBe(false);
  expect(isCausalOperationId("has space")).toBe(false);
  expect(isCausalOperationId("")).toBe(false);
});

test("decodes a search command without tenant credentials", () => {
  const command = decodeCausalAgentCommand({
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "search",
    operationId: "closing-work-items",
    query: "why did the deploy roll back",
    limit: 5,
  });
  expect(command).toEqual({
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "search",
    operationId: "closing-work-items",
    query: "why did the deploy roll back",
    limit: 5,
  });
  expect(JSON.stringify(command)).not.toContain("Bearer");
  expect(JSON.stringify(command)).not.toContain("tenantToken");
});

test("decodes offer and correction-proposal commands with citation refs", () => {
  expect(
    decodeCausalAgentCommand({
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      conversationId: "conv-1",
      targetAgentId: "agent-2",
      recipientRationale: "owns the deploy task",
      citationRefs: ["item:decision-1"],
      body: "the last skip-tests deploy rolled back",
    }).op,
  ).toBe("offer");
  expect(
    decodeCausalAgentCommand({
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "propose_correction",
      operationId: "corr-1",
      causalItemId: "decision-1",
      contradictoryCitationRefs: ["item:decision-2"],
      rationale: "later admitted evidence contradicts the old conclusion",
    }).op,
  ).toBe("propose_correction");
});

test("rejects a malformed command before it can cross the proxy", () => {
  expect(() =>
    decodeCausalAgentCommand({
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId: "not a key",
      query: "x",
    }),
  ).toThrow("invalid causal operationId");
  expect(() =>
    decodeCausalAgentCommand({
      protocol: "other",
      op: "search",
      operationId: "ok-1",
      query: "x",
    }),
  ).toThrow("invalid causal protocol");
});

test("decodes a cited read response and a replayed offer", () => {
  expect(isCausalCitation(citation)).toBe(true);
  expect(
    decodeCausalAgentResponse("search", {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId: "closing-work-items",
      duplicate: false,
      items: [citation],
    }),
  ).toEqual({
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "search",
    operationId: "closing-work-items",
    duplicate: false,
    items: [citation],
  });
  expect(
    decodeCausalAgentResponse("offer", {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      published: true,
      duplicate: true,
      messageId: "msg-1",
      recipientAgentId: "agent-2",
      citations: [citation],
    }).duplicate,
  ).toBe(true);
});

test("keeps agent errors sanitized and enumerated", () => {
  expect(CAUSAL_AGENT_ERROR_CODES).toContain("causal-citation-ungrounded");
  expect(
    isCausalAgentError({
      protocol: CAUSAL_AGENT_PROTOCOL,
      operationId: "offer-1",
      error: { code: "causal-citation-ungrounded", message: "citation was not served" },
    }),
  ).toBe(true);
  expect(
    isCausalAgentError({
      protocol: CAUSAL_AGENT_PROTOCOL,
      error: { code: "internal-db", message: "password=secret" },
    }),
  ).toBe(false);
});
