import { expect, test } from "bun:test";
import { OPENVIKING_CITATION_KIND, type OpenVikingCitation } from "@lrm/coforge-sdk/agent";
import type { OpenVikingCitationRecord } from "../db/repositories/workspace-memory-citation.repositories.server";
import { createMemoryCitationBindings, MemoryCitationUngroundedError } from "./memory-citations";

const openvikingHit = {
  citationId: "ov:wiki/deploy",
  workspaceId: "ws-a",
  accountId: "acct-a",
  uri: "viking://resources/docs/deploy.md",
  contentHash: "sha256:abc",
  matchedLevel: "L2",
  title: "Deploy rollback",
  excerpt: "the last skip-tests deploy rolled back",
};

function citationStore() {
  const rows = new Map<string, OpenVikingCitationRecord>();
  return {
    rows,
    async putOpenVikingCitation(record: OpenVikingCitationRecord) {
      rows.set(`${record.workspaceId}:${record.citationId}`, record);
      return record;
    },
    async getOpenVikingCitation(workspaceId: string, citationId: string) {
      return rows.get(`${workspaceId}:${citationId}`) ?? null;
    },
  };
}

function bindings() {
  const openviking = citationStore();
  return { openviking, memory: createMemoryCitationBindings({ openviking }) };
}

test("binds OpenViking find/read hits as tagged citations and persists them", async () => {
  const { openviking, memory } = bindings();
  const [citation] = await memory.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  expect(citation).toMatchObject({
    kind: OPENVIKING_CITATION_KIND,
    citationId: "ov:wiki/deploy",
    workspaceId: "ws-a",
    accountId: "acct-a",
    uri: "viking://resources/docs/deploy.md",
    contentHash: "sha256:abc",
    matchedLevel: "L2",
    title: "Deploy rollback",
    excerpt: "the last skip-tests deploy rolled back",
  } satisfies OpenVikingCitation);
  expect(openviking.rows.get("ws-a:ov:wiki/deploy")?.boundOperationId).toBe("find-1");
});

test("forged, unserved, and undecodable citations cannot become an Offer", async () => {
  const { memory } = bindings();
  await memory.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  await expect(memory.resolveOfferCitations("ws-a", ["forged"])).rejects.toBeInstanceOf(
    MemoryCitationUngroundedError,
  );
  await expect(memory.resolveOfferCitations("ws-b", ["ov:wiki/deploy"])).rejects.toBeInstanceOf(
    MemoryCitationUngroundedError,
  );
  await expect(memory.resolveOfferCitations("ws-a", [])).rejects.toBeInstanceOf(
    MemoryCitationUngroundedError,
  );
  await expect(
    memory.bindOpenVikingHits("ws-a", "find-bad", [{ uri: "viking://x" }]),
  ).rejects.toBeInstanceOf(MemoryCitationUngroundedError);
});

test("Offer refs keep the single openviking kind", async () => {
  const { memory } = bindings();
  const ov = await memory.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  const resolved = await memory.resolveOfferCitations("ws-a", [ov[0]!.citationId]);
  expect(resolved.map((citation) => citation.kind)).toEqual([OPENVIKING_CITATION_KIND]);
  expect(memory.toOfferRefs(resolved)).toEqual([
    { kind: OPENVIKING_CITATION_KIND, citationId: "ov:wiki/deploy" },
  ]);
});
