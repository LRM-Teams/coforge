import { expect, test } from "bun:test";
import {
  CAUSAL_AGENT_PROTOCOL,
  CAUSAL_MEMORY_CITATION_KIND,
  decodeCausalAgentResponse,
  decodeOpenVikingAgentResponse,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_CITATION_KIND,
  workspaceProfileToToolFence,
} from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  OpenVikingCitationRecord,
} from "../db/repositories/workspace-memory-citation.repositories.server";
import {
  createInMemoryCausalMemoryCitationBindings,
  createMemoryCitationBindings,
} from "./memory-citations";
import { createMemoryAgentBudgetLedger } from "./memory-agent-budget";
import { createMemoryOffers } from "./memory-offers";
import { createOpenVikingMemoryReads } from "./openviking-memory-reads";
import { createMemoryAgentCommands } from "./memory-agent-route";

const ovHit = {
  uri: "viking://resources/docs/deploy.md",
  accountId: "acct-a",
  contentHash: "sha256:abc",
  matchedLevel: "L2",
  title: "Deploy rollback",
  excerpt: "skipped tests",
};

const causalHit = {
  citationId: "cm:decision-1",
  causalItemId: "decision-1",
  factVersion: 3,
  admittedSegmentId: "segment-1",
  sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
  displayContent: "skipping tests caused a rollback",
};

function commands(desired: "openviking" | "causal_openviking") {
  const ovRows = new Map<string, OpenVikingCitationRecord>();
  const offerRows = new Map<string, MemoryOfferRecord>();
  const gatewayCalls: Array<{ operation: string }> = [];
  const runtimeCalls: string[] = [];
  const mutations = { openviking: 0, causal: 0 };
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
    causal: createInMemoryCausalMemoryCitationBindings(),
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
    corrections: {
      async propose(input) {
        mutations.causal += 1;
        return { accepted: true, duplicate: false, proposalId: input.operationId };
      },
    },
  });
  const handler = createMemoryAgentCommands({
    fence: {
      async resolve() {
        return workspaceProfileToToolFence(desired);
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
    causalRuntime: {
      async request<T>(_path: string) {
        runtimeCalls.push(_path);
        return { duplicate: false, items: [causalHit] } as T;
      },
    },
    async tenantToken() {
      return "tok";
    },
  });
  return { handler, offerRows, gatewayCalls, runtimeCalls, mutations };
}

test("forged citations cannot become an Offer on either profile", async () => {
  for (const desired of ["openviking", "causal_openviking"] as const) {
    const { handler } = commands(desired);
    const result = await handler.handle({
      workspaceId: "ws-a",
      agentId: "mem-1",
      triggerMessageId: "msg-1",
      command: {
        protocol: desired === "openviking" ? OPENVIKING_AGENT_PROTOCOL : CAUSAL_AGENT_PROTOCOL,
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
  }
});

test("OpenViking citations cannot satisfy a correction", async () => {
  const { handler } = commands("causal_openviking");
  const found = await handler.handle({
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
  expect(found.ok).toBe(true);
  const result = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "propose_correction",
      operationId: "fix-ov",
      causalItemId: "decision-1",
      contradictoryCitationRefs: ["ov:viking://resources/docs/deploy.md"],
      rationale: "OV is not admitted provenance",
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.message).toContain("openviking citation cannot satisfy causal correction");
});

test("mixed causal_openviking answers preserve citation kinds on the Offer record", async () => {
  const { handler, offerRows } = commands("causal_openviking");
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
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId: "search-1",
      query: "deploy",
    },
  });
  const offered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      conversationId: "ch-1",
      targetAgentId: "helper-1",
      recipientRationale: "owns the task",
      citationRefs: ["ov:viking://resources/docs/deploy.md", "cm:decision-1"],
      body: "mixed evidence",
    },
  });
  expect(offered.ok).toBe(true);
  if (!offered.ok) throw new Error("expected mixed offer");
  if (offered.response.op !== "offer") throw new Error("expected offer op");
  expect(offered.response.citations).toEqual([
    expect.objectContaining({
      kind: CAUSAL_MEMORY_CITATION_KIND,
      citationId: "cm:decision-1",
    }),
  ]);
  expect(offered.response.openvikingCitations).toEqual([
    expect.objectContaining({
      kind: OPENVIKING_CITATION_KIND,
      citationId: "ov:viking://resources/docs/deploy.md",
    }),
  ]);
  expect(decodeCausalAgentResponse("offer", offered.response)).toMatchObject({
    op: "offer",
    citations: [expect.objectContaining({ citationId: "cm:decision-1" })],
  });
  expect(offerRows.get("ws-a:offer-1")?.citations).toEqual([
    { kind: OPENVIKING_CITATION_KIND, citationId: "ov:viking://resources/docs/deploy.md" },
    { kind: CAUSAL_MEMORY_CITATION_KIND, citationId: "cm:decision-1" },
  ]);

  const ovOffered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-2",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-ov",
      conversationId: "ch-1",
      targetAgentId: "helper-1",
      recipientRationale: "owns the task",
      citationRefs: ["ov:viking://resources/docs/deploy.md", "cm:decision-1"],
      body: "mixed evidence via ov protocol",
    },
  });
  expect(ovOffered.ok).toBe(true);
  if (!ovOffered.ok) throw new Error("expected mixed ov offer");
  if (ovOffered.response.op !== "offer") throw new Error("expected offer op");
  expect(ovOffered.response.citations).toEqual([
    expect.objectContaining({
      kind: OPENVIKING_CITATION_KIND,
      citationId: "ov:viking://resources/docs/deploy.md",
    }),
  ]);
  expect(ovOffered.response.causalCitations).toEqual([
    expect.objectContaining({
      kind: CAUSAL_MEMORY_CITATION_KIND,
      citationId: "cm:decision-1",
    }),
  ]);
  expect(decodeOpenVikingAgentResponse("offer", ovOffered.response)).toMatchObject({
    op: "offer",
    citations: [expect.objectContaining({ citationId: "ov:viking://resources/docs/deploy.md" })],
  });
});

test("both profiles execute the shared read and Offer budget", async () => {
  const ov = commands("openviking");
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

  const mixed = commands("causal_openviking");
  await mixed.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-cm",
    command: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId: "search-1",
      query: "deploy",
    },
  });
  await mixed.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-cm",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: "find-1",
      query: "deploy",
    },
  });
  const offer = {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "offer" as const,
    conversationId: "ch-1",
    targetAgentId: "helper-1",
    recipientRationale: "owns the task",
    citationRefs: ["cm:decision-1"],
    body: "cited",
  };
  const firstOffer = await mixed.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-cm",
    command: { ...offer, operationId: "offer-1" },
  });
  expect(firstOffer.ok).toBe(true);
  const secondOffer = await mixed.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-cm",
    command: { ...offer, operationId: "offer-2" },
  });
  expect(secondOffer.ok).toBe(false);
  if (secondOffer.ok) throw new Error("expected offer budget failure");
  expect(secondOffer.code).toBe("causal-budget-exhausted");
});

test("Memory Agent citation paths do not write OpenViking and only propose causal correction", async () => {
  const { handler, gatewayCalls, runtimeCalls, mutations } = commands("causal_openviking");
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
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId: "search-1",
      query: "deploy",
    },
  });
  expect(runtimeCalls.every((path) => path.includes("/search"))).toBe(true);
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "propose_correction",
      operationId: "fix-1",
      causalItemId: "decision-1",
      contradictoryCitationRefs: ["cm:decision-1"],
      rationale: "later admitted evidence",
    },
  });
  expect(mutations).toEqual({ openviking: 0, causal: 1 });
});

test("openviking profile cannot invoke causal commands", async () => {
  const { handler } = commands("openviking");
  const result = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId: "search-1",
      query: "deploy",
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected unauthorized");
  expect(result.code).toBe("causal-unauthorized");
});
