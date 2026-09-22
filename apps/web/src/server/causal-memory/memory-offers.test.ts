import { expect, test } from "bun:test";
import {
  CAUSAL_MEMORY_CITATION_KIND,
  OPENVIKING_CITATION_KIND,
  type CausalMemoryCitation,
} from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  OpenVikingCitationRecord,
} from "../db/repositories/workspace-memory-citation.repositories.server";
import {
  createInMemoryCausalMemoryCitationBindings,
  createMemoryCitationBindings,
  MemoryCitationCorrectionError,
  MemoryCitationUngroundedError,
} from "./memory-citations";
import { createMemoryOffers } from "./memory-offers";

const causalHit = {
  citationId: "cm:decision-1",
  causalItemId: "decision-1",
  factVersion: 3,
  admittedSegmentId: "segment-1",
  sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
  displayContent: "skipping tests caused a rollback",
};

const openvikingHit = {
  citationId: "ov:wiki/deploy",
  workspaceId: "ws-a",
  accountId: "acct-a",
  uri: "viking://resources/docs/deploy.md",
  contentHash: "sha256:abc",
  matchedLevel: "L2",
  excerpt: "the last skip-tests deploy rolled back",
};

function harness() {
  const ovRows = new Map<string, OpenVikingCitationRecord>();
  const offerRows = new Map<string, MemoryOfferRecord>();
  const published: Array<{ body: string; recipientAgentId: string }> = [];
  const proposed: Array<{ causalItemId: string; citations: CausalMemoryCitation[] }> = [];
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
      async publish(input) {
        published.push({ body: input.body, recipientAgentId: input.recipientAgentId });
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
        proposed.push({ causalItemId: input.causalItemId, citations: input.citations });
        return { accepted: true, duplicate: false, proposalId: input.operationId };
      },
    },
  });
  return { citations, offers, published, proposed, mutations, offerRows };
}

test("a mixed Offer keeps each citation kind and never writes OpenViking or Causal Memory", async () => {
  const { citations, offers, published, offerRows, mutations } = harness();
  await citations.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  await citations.bindCausalHits("ws-a", "search-1", [causalHit]);
  const result = await offers.publish({
    workspaceId: "ws-a",
    operationId: "offer-1",
    conversationId: "ch-1",
    targetAgentId: "helper-1",
    recipientRationale: "owns the deploy task",
    citationRefs: ["ov:wiki/deploy", "cm:decision-1"],
    body: "cited mixed evidence",
    memoryAgentId: "memory-1",
  });
  expect(result.citations.map((citation) => citation.kind)).toEqual([
    OPENVIKING_CITATION_KIND,
    CAUSAL_MEMORY_CITATION_KIND,
  ]);
  expect(offerRows.get("ws-a:offer-1")?.citations).toEqual([
    { kind: OPENVIKING_CITATION_KIND, citationId: "ov:wiki/deploy" },
    { kind: CAUSAL_MEMORY_CITATION_KIND, citationId: "cm:decision-1" },
  ]);
  expect(published).toEqual([{ body: "cited mixed evidence", recipientAgentId: "helper-1" }]);
  expect(mutations).toEqual({ openviking: 0, causal: 0 });
});

test("forged citations cannot produce an Offer", async () => {
  const { offers } = harness();
  await expect(
    offers.publish({
      workspaceId: "ws-a",
      operationId: "offer-forged",
      conversationId: "ch-1",
      targetAgentId: "helper-1",
      recipientRationale: "guess",
      citationRefs: ["forged"],
      body: "no",
      memoryAgentId: "memory-1",
    }),
  ).rejects.toBeInstanceOf(MemoryCitationUngroundedError);
});

test("OpenViking citations cannot satisfy a correction and do not mutate either runtime", async () => {
  const { citations, offers, proposed, mutations } = harness();
  await citations.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  await citations.bindCausalHits("ws-a", "search-1", [causalHit]);
  await expect(
    offers.proposeCorrection({
      workspaceId: "ws-a",
      operationId: "fix-ov",
      causalItemId: "decision-1",
      contradictoryCitationRefs: ["ov:wiki/deploy"],
      rationale: "OV summary is not admitted provenance",
    }),
  ).rejects.toBeInstanceOf(MemoryCitationCorrectionError);
  expect(proposed).toEqual([]);
  const accepted = await offers.proposeCorrection({
    workspaceId: "ws-a",
    operationId: "fix-1",
    causalItemId: "decision-1",
    contradictoryCitationRefs: ["cm:decision-1"],
    rationale: "later admitted evidence contradicts it",
  });
  expect(accepted).toEqual({ accepted: true, duplicate: false, proposalId: "fix-1" });
  expect(
    proposed[0]?.citations.every((citation) => citation.kind === CAUSAL_MEMORY_CITATION_KIND),
  ).toBe(true);
  expect(mutations).toEqual({ openviking: 0, causal: 0 });
});
