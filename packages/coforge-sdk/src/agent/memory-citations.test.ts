import { expect, test } from "bun:test";
import {
  OPENVIKING_CITATION_KIND,
  decodeMemoryCitation,
  decodeOpenVikingCitationList,
  isOpenVikingCitation,
  type OpenVikingCitation,
} from "./memory-citations";

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

test("decodes a versioned OpenViking citation", () => {
  expect(decodeMemoryCitation(openvikingCitation)).toEqual(openvikingCitation);
  expect(isOpenVikingCitation(openvikingCitation)).toBe(true);
  expect(isOpenVikingCitation({ ...openvikingCitation, kind: "memory" })).toBe(false);
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
  expect(() => decodeMemoryCitation({ ...openvikingCitation, kind: "memory" })).toThrow(
    "invalid memory citation kind",
  );
  expect(() =>
    decodeMemoryCitation({
      ...openvikingCitation,
      causalItemId: "decision-1",
      admittedSegmentId: "segment-1",
    }),
  ).toThrow("mixed memory citation");
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

test("decodes citation lists and rejects non-array input", () => {
  expect(decodeOpenVikingCitationList([openvikingCitation])).toEqual([openvikingCitation]);
  expect(() => decodeOpenVikingCitationList(openvikingCitation)).toThrow(
    "invalid openviking citation list",
  );
});
