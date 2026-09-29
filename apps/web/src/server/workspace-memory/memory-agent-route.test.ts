import { expect, test } from "bun:test";
import {
  decodeOpenVikingAgentResponse,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_CITATION_KIND,
  workspaceProfileToToolFence,
} from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  OpenVikingCitationRecord,
} from "../db/repositories/workspace-memory-citation.repositories.server";
import { createMemoryCitationBindings } from "./memory-citations";
import { createMemoryAgentBudgetLedger } from "./memory-agent-budget";
import { createMemoryOffers } from "./memory-offers";
import { createOpenVikingMemoryReads } from "../openviking/openviking-memory-reads";
import { createMemoryAgentCommands } from "./memory-agent-route";

const ovHit = {
  uri: "viking://resources/docs/deploy.md",
  accountId: "acct-a",
  contentHash: "sha256:abc",
  matchedLevel: "L2",
  title: "Deploy rollback",
  excerpt: "skipped tests",
};

function commands(
  extras: {
    offerTargets?: {
      resolve: () => Promise<{ conversationId: string; targetAgentId: string } | null>;
    };
  } = {},
) {
  const ovRows = new Map<string, OpenVikingCitationRecord>();
  const offerRows = new Map<string, MemoryOfferRecord>();
  const gatewayCalls: Array<{ operation: string }> = [];
  const citations = createMemoryCitationBindings({
    openviking: {
      async putOpenVikingCitation(record) {
        ovRows.set(`${record.workspaceId}:${record.citationId}`, record);
        return record;
      },
      async getOpenVikingCitation(workspaceId, citationId) {
        return ovRows.get(`${workspaceId}:${citationId}`) ?? null;
      },
    },
  });
  const offers = createMemoryOffers({
    citations,
    offers: {
      async getOffer(workspaceId, operationId) {
        return offerRows.get(`${workspaceId}:${operationId}`) ?? null;
      },
      async putOffer(input) {
        offerRows.set(`${input.workspaceId}:${input.operationId}`, input);
        return { outcome: "saved" as const, offer: input };
      },
    },
    publisher: {
      async publish() {
        return { messageId: "offer-msg" };
      },
    },
    channels: {
      async isActiveChannelAgent() {
        return true;
      },
    },
  });
  const handler = createMemoryAgentCommands({
    fence: {
      async resolve() {
        return workspaceProfileToToolFence("openviking");
      },
    },
    directory: {
      async isDesignated() {
        return true;
      },
    },
    budgets: createMemoryAgentBudgetLedger(),
    citations,
    offers,
    openviking: createOpenVikingMemoryReads({
      client: {
        async invoke(request) {
          gatewayCalls.push({ operation: request.operation });
          return { results: [ovHit] };
        },
      },
      citations,
    }),
    ...(extras.offerTargets ? { offerTargets: extras.offerTargets } : {}),
  });
  return { handler, offerRows, gatewayCalls };
}

test("forged citations cannot become an Offer", async () => {
  const { handler } = commands();
  const result = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-forged",
      conversationId: "ch-1",
      targetAgentId: "helper-1",
      recipientRationale: "guess",
      citationRefs: ["forged"],
      body: "no",
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toContain("citation-ungrounded");
});

test("openviking answers preserve the citation kind on the Offer record", async () => {
  const { handler, offerRows } = commands();
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: "find-1",
      query: "deploy",
    },
  });
  const offered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      conversationId: "ch-1",
      targetAgentId: "helper-1",
      recipientRationale: "owns the task",
      citationRefs: ["ov:viking://resources/docs/deploy.md"],
      body: "cited evidence",
    },
  });
  expect(offered.ok).toBe(true);
  if (!offered.ok) throw new Error("expected offer");
  if (offered.response.op !== "offer") throw new Error("expected offer op");
  expect(offered.response.citations).toEqual([
    expect.objectContaining({
      kind: OPENVIKING_CITATION_KIND,
      citationId: "ov:viking://resources/docs/deploy.md",
    }),
  ]);
  expect(decodeOpenVikingAgentResponse("offer", offered.response)).toMatchObject({
    op: "offer",
    citations: [expect.objectContaining({ citationId: "ov:viking://resources/docs/deploy.md" })],
  });
  expect(offerRows.get("ws-a:offer-1")?.citations).toEqual([
    { kind: OPENVIKING_CITATION_KIND, citationId: "ov:viking://resources/docs/deploy.md" },
  ]);
});

test("the openviking profile executes the shared read and Offer budget", async () => {
  const ov = commands();
  for (const index of [1, 2, 3]) {
    const read = await ov.handler.handle({
      workspaceId: "ws-a",
      agentId: "mem-1",
      triggerMessageId: "msg-ov",
      command: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "find",
        operationId: `find-${index}`,
        query: "deploy",
      },
    });
    expect(read.ok).toBe(true);
  }
  const fourth = await ov.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-ov",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: "find-4",
      query: "deploy",
    },
  });
  expect(fourth.ok).toBe(false);
  if (fourth.ok) throw new Error("expected budget failure");
  expect(fourth.code).toBe("openviking-budget-exhausted");

  const offer = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    conversationId: "ch-1",
    targetAgentId: "helper-1",
    recipientRationale: "owns the task",
    citationRefs: ["ov:viking://resources/docs/deploy.md"],
    body: "cited",
  };
  const firstOffer = await ov.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-ov",
    command: { ...offer, operationId: "offer-1" },
  });
  expect(firstOffer.ok).toBe(true);
  const secondOffer = await ov.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-ov",
    command: { ...offer, operationId: "offer-2" },
  });
  expect(secondOffer.ok).toBe(false);
  if (secondOffer.ok) throw new Error("expected offer budget failure");
  expect(secondOffer.code).toBe("openviking-budget-exhausted");
});

test("Memory Agent citation paths never write OpenViking", async () => {
  const { handler, gatewayCalls } = commands();
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: "find-1",
      query: "deploy",
    },
  });
  expect(gatewayCalls.every((call) => call.operation === "find")).toBe(true);
});

test("foreign protocol commands are rejected as invalid", async () => {
  const { handler } = commands();
  const result = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: "coforge.causal.agent.v1",
      op: "search",
      operationId: "search-1",
      query: "deploy",
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid");
  expect(result.code).toBe("openviking-request-invalid");
});

test("an offer omits channel ids and the server binds the unanswered @memory target", async () => {
  const { handler, offerRows } = commands({
    offerTargets: {
      async resolve() {
        return { conversationId: "ch-bound", targetAgentId: "task-1" };
      },
    },
  });
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: "find-1",
      query: "deploy",
    },
  });
  const offered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-2",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-bound",
      citationRefs: ["ov:viking://resources/docs/deploy.md"],
      body: "cited from an earlier retrieval",
    },
  });
  expect(offered.ok).toBe(true);
  expect(offerRows.get("ws-a:offer-bound")).toMatchObject({
    conversationId: "ch-bound",
    recipientAgentId: "task-1",
    recipientRationale: "answers the explicit @memory question",
  });
});

test("an offer without channel ids fails when no @memory target is bound", async () => {
  const { handler } = commands();
  const offered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-unbound",
      citationRefs: ["ov:viking://resources/docs/deploy.md"],
      body: "cited",
    },
  });
  expect(offered.ok).toBe(false);
  if (offered.ok) throw new Error("expected unresolved target");
  expect(offered.message).toContain("unresolved");
});
