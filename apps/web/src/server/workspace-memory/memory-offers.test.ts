import { expect, test } from "bun:test";
import { OPENVIKING_CITATION_KIND } from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  OpenVikingCitationRecord,
} from "../db/repositories/workspace-memory-citation.repositories.server";
import { createMemoryCitationBindings, MemoryCitationUngroundedError } from "./memory-citations";
import { createMemoryOffers } from "./memory-offers";

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
  });
  return { citations, offers, published, offerRows };
}

test("an Offer keeps its citation kind and never writes OpenViking", async () => {
  const { citations, offers, published, offerRows } = harness();
  await citations.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  const result = await offers.publish({
    workspaceId: "ws-a",
    operationId: "offer-1",
    conversationId: "ch-1",
    targetAgentId: "helper-1",
    recipientRationale: "owns the deploy task",
    citationRefs: ["ov:wiki/deploy"],
    body: "cited deploy evidence",
    memoryAgentId: "memory-1",
  });
  expect(result.citations.map((citation) => citation.kind)).toEqual([OPENVIKING_CITATION_KIND]);
  expect(offerRows.get("ws-a:offer-1")?.citations).toEqual([
    { kind: OPENVIKING_CITATION_KIND, citationId: "ov:wiki/deploy" },
  ]);
  expect(published).toEqual([{ body: "cited deploy evidence", recipientAgentId: "helper-1" }]);
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
