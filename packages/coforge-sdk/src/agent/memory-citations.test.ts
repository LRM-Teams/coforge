import { expect, test } from "bun:test";
import {
  CAUSAL_MEMORY_CITATION_KIND,
  OPENVIKING_CITATION_KIND,
  decodeCausalCorrectionEvidence,
  decodeMemoryCitation,
  isCausalMemoryCitation,
  isOpenVikingCitation,
  type CausalCorrectionEvidence,
  type CausalMemoryCitation,
  type OpenVikingCitation,
} from "./memory-citations";

const causalCitation: CausalMemoryCitation = {
  kind: CAUSAL_MEMORY_CITATION_KIND,
  citationId: "cm:decision-1",
  causalItemId: "decision-1",
  causalPathId: "path-1",
  factVersion: 3,
  admittedSegmentId: "segment-1",
  sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
  displayContent: "skipping tests caused a rollback",
};

const openvikingCitation: OpenVikingCitation = {
  kind: OPENVIKING_CITATION_KIND,
  citationId: "ov:wiki/deploy",
  workspaceId: "workspace-1",
  accountId: "ov-account-1",
  uri: "viking://workspace-1/docs/deploy.md",
  contentHash: "sha256:abc",
  matchedLevel: "L2",
  title: "Deploy rollback",
  excerpt: "the last skip-tests deploy rolled back",
};

test("decodes tagged OpenViking and versioned Causal Memory citations", () => {
  expect(decodeMemoryCitation(openvikingCitation)).toEqual(openvikingCitation);
  expect(decodeMemoryCitation(causalCitation)).toEqual(causalCitation);
  expect(isOpenVikingCitation(openvikingCitation)).toBe(true);
  expect(isCausalMemoryCitation(causalCitation)).toBe(true);
  expect(isOpenVikingCitation(causalCitation)).toBe(false);
  expect(isCausalMemoryCitation(openvikingCitation)).toBe(false);
});

test("accepts an OpenViking citation versioned by content version instead of hash", () => {
  const versioned = {
    kind: OPENVIKING_CITATION_KIND,
    citationId: "ov:wiki/runbook",
    workspaceId: "workspace-1",
    accountId: "ov-account-1",
    uri: "viking://workspace-1/docs/runbook.md",
    contentVersion: "v12",
    matchedLevel: "L1" as const,
    excerpt: "on-call runbook",
  };
  expect(decodeMemoryCitation(versioned)).toEqual(versioned);
});

test("fail-closes malformed, mixed, and unversioned citations", () => {
  expect(() => decodeMemoryCitation(null)).toThrow("invalid memory citation");
  expect(() => decodeMemoryCitation({ ...causalCitation, kind: "memory" })).toThrow(
    "invalid memory citation kind",
  );
  expect(() =>
    decodeMemoryCitation({
      ...openvikingCitation,
      causalItemId: "decision-1",
      admittedSegmentId: "segment-1",
    }),
  ).toThrow("mixed memory citation");
  expect(() => decodeMemoryCitation({ ...causalCitation, uri: openvikingCitation.uri })).toThrow(
    "mixed memory citation",
  );
  expect(() => decodeMemoryCitation({ ...causalCitation, factVersion: undefined })).toThrow(
    "unversioned causal memory citation",
  );
  expect(() => decodeMemoryCitation({ ...causalCitation, factVersion: 0 })).toThrow(
    "unversioned causal memory citation",
  );
  const { contentHash: _hash, ...unversionedOpenviking } = openvikingCitation;
  expect(() => decodeMemoryCitation(unversionedOpenviking)).toThrow(
    "unversioned openviking citation",
  );
});

test("strips tenant credentials and never echoes them on a valid citation", () => {
  const decoded = decodeMemoryCitation({
    ...openvikingCitation,
    tenantToken: "secret-tenant",
    apiKey: "ov-key",
    authorization: "Bearer leaked",
  });
  expect(decoded).toEqual(openvikingCitation);
  expect(JSON.stringify(decoded)).not.toContain("secret-tenant");
  expect(JSON.stringify(decoded)).not.toContain("Bearer");
  expect(JSON.stringify(decoded)).not.toContain("apiKey");
  expect("tenantToken" in decoded).toBe(false);
});

test("rejects OpenViking citations as causal correction evidence", () => {
  expect(decodeCausalCorrectionEvidence([causalCitation])).toEqual([causalCitation]);
  expect(() => decodeCausalCorrectionEvidence([openvikingCitation])).toThrow(
    "openviking citation cannot satisfy causal correction",
  );
  expect(() => decodeCausalCorrectionEvidence([causalCitation, openvikingCitation])).toThrow(
    "openviking citation cannot satisfy causal correction",
  );
  expect(() => decodeCausalCorrectionEvidence([])).toThrow("invalid causal correction evidence");
});

test("keeps correction evidence typed as causal citations only", () => {
  const evidence: CausalCorrectionEvidence = [causalCitation];
  expect(evidence.every(isCausalMemoryCitation)).toBe(true);
  // @ts-expect-error OpenViking citations are not causal correction evidence
  const _blocked: CausalCorrectionEvidence = [openvikingCitation];
  void _blocked;
});
