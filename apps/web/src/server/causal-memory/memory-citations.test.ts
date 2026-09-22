import { expect, test } from "bun:test";
import {
  CAUSAL_MEMORY_CITATION_KIND,
  OPENVIKING_CITATION_KIND,
  type CausalMemoryCitation,
  type OpenVikingCitation,
} from "@lrm/coforge-sdk/agent";
import type { OpenVikingCitationRecord } from "../db/repositories/workspace-memory-citation.repositories.server";
import type { CausalCitationRecord } from "./contract";
import {
  createInMemoryCausalMemoryCitationBindings,
  createMemoryCitationBindings,
  createPrismaCausalMemoryCitationBindings,
  decodeCausalPathVersion,
  encodeCausalPathVersion,
  MemoryCitationCorrectionError,
  MemoryCitationUngroundedError,
} from "./memory-citations";

const causalHit = {
  citationId: "cm:decision-1",
  causalItemId: "decision-1",
  causalPathId: "path-1",
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
  const causal = createInMemoryCausalMemoryCitationBindings();
  return { openviking, causal, memory: createMemoryCitationBindings({ openviking, causal }) };
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

test("binds hydrated causal facts as versioned CausalMemoryCitation with admitted provenance", async () => {
  const { causal, memory } = bindings();
  const [citation] = await memory.bindCausalHits("ws-a", "search-1", [causalHit]);
  expect(citation).toEqual<CausalMemoryCitation>({
    kind: CAUSAL_MEMORY_CITATION_KIND,
    citationId: "cm:decision-1",
    causalItemId: "decision-1",
    causalPathId: "path-1",
    factVersion: 3,
    admittedSegmentId: "segment-1",
    sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
    displayContent: "skipping tests caused a rollback",
  });
  expect(await causal.get("ws-a", "cm:decision-1")).toMatchObject({
    factVersion: 3,
    admittedSegmentId: "segment-1",
    boundOperationId: "search-1",
  });
});

test("forged, unserved, and undecodable citations cannot become an Offer", async () => {
  const { memory } = bindings();
  await memory.bindCausalHits("ws-a", "search-1", [causalHit]);
  await expect(memory.resolveOfferCitations("ws-a", ["forged"])).rejects.toBeInstanceOf(
    MemoryCitationUngroundedError,
  );
  await expect(memory.resolveOfferCitations("ws-b", ["cm:decision-1"])).rejects.toBeInstanceOf(
    MemoryCitationUngroundedError,
  );
  await expect(
    memory.bindOpenVikingHits("ws-a", "find-bad", [{ uri: "viking://x" }]),
  ).rejects.toBeInstanceOf(MemoryCitationUngroundedError);
  await expect(
    memory.bindCausalHits("ws-a", "search-bad", [{ citationId: "cm:x" }]),
  ).rejects.toBeInstanceOf(MemoryCitationUngroundedError);
});

test("mixed Offer refs keep openviking and causal_memory kinds separate", async () => {
  const { memory } = bindings();
  const ov = await memory.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  const cm = await memory.bindCausalHits("ws-a", "search-1", [causalHit]);
  const resolved = await memory.resolveOfferCitations("ws-a", [
    ov[0]!.citationId,
    cm[0]!.citationId,
  ]);
  expect(resolved.map((citation) => citation.kind)).toEqual([
    OPENVIKING_CITATION_KIND,
    CAUSAL_MEMORY_CITATION_KIND,
  ]);
  expect(memory.toOfferRefs(resolved)).toEqual([
    { kind: OPENVIKING_CITATION_KIND, citationId: "ov:wiki/deploy" },
    { kind: CAUSAL_MEMORY_CITATION_KIND, citationId: "cm:decision-1" },
  ]);
});

test("correction accepts only served CausalMemoryCitation and rejects OpenViking citations", async () => {
  const { memory } = bindings();
  await memory.bindOpenVikingHits("ws-a", "find-1", [openvikingHit]);
  await memory.bindCausalHits("ws-a", "search-1", [causalHit]);
  const evidence = await memory.resolveCorrectionEvidence("ws-a", ["cm:decision-1"]);
  expect(evidence).toEqual([
    {
      kind: CAUSAL_MEMORY_CITATION_KIND,
      citationId: "cm:decision-1",
      causalItemId: "decision-1",
      causalPathId: "path-1",
      factVersion: 3,
      admittedSegmentId: "segment-1",
      sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
      displayContent: "skipping tests caused a rollback",
    },
  ]);
  await expect(memory.resolveCorrectionEvidence("ws-a", ["ov:wiki/deploy"])).rejects.toBeInstanceOf(
    MemoryCitationCorrectionError,
  );
  await expect(
    memory.resolveCorrectionEvidence("ws-a", ["cm:decision-1", "ov:wiki/deploy"]),
  ).rejects.toBeInstanceOf(MemoryCitationCorrectionError);
  await expect(memory.resolveCorrectionEvidence("ws-a", ["missing"])).rejects.toBeInstanceOf(
    MemoryCitationUngroundedError,
  );
});

test("encodes factVersion onto the causal path so F4 can reconstruct a versioned citation", () => {
  expect(encodeCausalPathVersion("path-1", 3)).toBe("__v3__:path-1");
  expect(decodeCausalPathVersion("__v3__:path-1")).toEqual({
    factVersion: 3,
    causalPathId: "path-1",
  });
  expect(decodeCausalPathVersion("__v2__")).toEqual({ factVersion: 2 });
  expect(decodeCausalPathVersion("legacy-path")).toEqual({ causalPathId: "legacy-path" });
});

test("Prisma causal bindings persist factVersion and hide unversioned legacy rows from F4", async () => {
  const rows = new Map<string, CausalCitationRecord>();
  const bindings = createPrismaCausalMemoryCitationBindings({
    async putCitation(input) {
      rows.set(`${input.workspaceId}:${input.citationId}`, input);
      return input;
    },
    async getCitation(workspaceId, citationId) {
      return rows.get(`${workspaceId}:${citationId}`);
    },
  });
  await bindings.put({
    kind: CAUSAL_MEMORY_CITATION_KIND,
    citationId: "cm:decision-1",
    causalItemId: "decision-1",
    causalPathId: "path-1",
    factVersion: 3,
    admittedSegmentId: "segment-1",
    sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
    displayContent: "skipping tests caused a rollback",
    workspaceId: "ws-a",
    boundOperationId: "search-1",
  });
  expect(rows.get("ws-a:cm:decision-1")?.causalPathId).toBe("__v3__:path-1");
  expect(await bindings.get("ws-a", "cm:decision-1")).toMatchObject({
    kind: CAUSAL_MEMORY_CITATION_KIND,
    factVersion: 3,
    causalPathId: "path-1",
  });
  rows.set("ws-a:legacy", {
    workspaceId: "ws-a",
    citationId: "legacy",
    causalItemId: "old",
    admittedSegmentId: "segment-1",
    sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
    boundOperationId: "old-1",
    displayContent: "unversioned",
  });
  expect(await bindings.get("ws-a", "legacy")).toBeNull();
});
