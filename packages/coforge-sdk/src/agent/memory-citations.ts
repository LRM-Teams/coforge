/**
 * Memory Agent citation contract.
 *
 * A citation is a versioned OpenViking object reference. It proves which
 * retrievable object was used; it is not free-form source text.
 */

export const OPENVIKING_CITATION_KIND = "openviking" as const;

export const OPENVIKING_MATCHED_LEVELS = ["L0", "L1", "L2"] as const;
export type OpenVikingMatchedLevel = (typeof OPENVIKING_MATCHED_LEVELS)[number];

const FOREIGN_CITATION_FIELDS = [
  "causalItemId",
  "causalPathId",
  "factVersion",
  "admittedSegmentId",
  "sourceMessageIds",
] as const;

export type OpenVikingCitation = {
  kind: typeof OPENVIKING_CITATION_KIND;
  citationId: string;
  workspaceId: string;
  accountId: string;
  uri: string;
  contentHash?: string;
  contentVersion?: string;
  matchedLevel: OpenVikingMatchedLevel;
  title?: string;
  excerpt?: string;
};

export type MemoryCitation = OpenVikingCitation;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectMixedFields(value: object, unexpected: readonly string[], kindLabel: string): void {
  if (unexpected.some((field) => hasOwn(value, field)))
    throw new Error(`mixed memory citation: ${kindLabel} citation carries foreign fields`);
}

function isOpenVikingMatchedLevel(value: unknown): value is OpenVikingMatchedLevel {
  return (
    typeof value === "string" && (OPENVIKING_MATCHED_LEVELS as readonly string[]).includes(value)
  );
}

export function isOpenVikingCitation(value: unknown): value is OpenVikingCitation {
  try {
    decodeOpenVikingCitation(value);
    return true;
  } catch {
    return false;
  }
}

export function decodeOpenVikingCitation(value: unknown): OpenVikingCitation {
  if (!value || typeof value !== "object") throw new Error("invalid memory citation");
  const citation = value as Record<string, unknown>;
  if (citation.kind !== OPENVIKING_CITATION_KIND) throw new Error("invalid memory citation kind");
  rejectMixedFields(citation, [...FOREIGN_CITATION_FIELDS], "openviking");
  if (!isNonEmptyString(citation.citationId)) throw new Error("invalid openviking citationId");
  if (!isNonEmptyString(citation.workspaceId)) throw new Error("invalid openviking workspaceId");
  if (!isNonEmptyString(citation.accountId)) throw new Error("invalid openviking accountId");
  if (!isNonEmptyString(citation.uri)) throw new Error("invalid openviking uri");
  if (!isOpenVikingMatchedLevel(citation.matchedLevel))
    throw new Error("invalid openviking matchedLevel");
  const contentHash = citation.contentHash;
  const contentVersion = citation.contentVersion;
  if (contentHash !== undefined && !isNonEmptyString(contentHash))
    throw new Error("invalid openviking contentHash");
  if (contentVersion !== undefined && !isNonEmptyString(contentVersion))
    throw new Error("invalid openviking contentVersion");
  if (!isNonEmptyString(contentHash) && !isNonEmptyString(contentVersion))
    throw new Error("unversioned openviking citation");
  if (citation.title !== undefined && typeof citation.title !== "string")
    throw new Error("invalid openviking title");
  if (citation.excerpt !== undefined && typeof citation.excerpt !== "string")
    throw new Error("invalid openviking excerpt");
  if (
    (citation.title === undefined || citation.title === "") &&
    (citation.excerpt === undefined || citation.excerpt === "")
  )
    throw new Error("invalid openviking citation display");

  return {
    kind: OPENVIKING_CITATION_KIND,
    citationId: citation.citationId,
    workspaceId: citation.workspaceId,
    accountId: citation.accountId,
    uri: citation.uri,
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(contentVersion === undefined ? {} : { contentVersion }),
    matchedLevel: citation.matchedLevel,
    ...(citation.title ? { title: citation.title } : {}),
    ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
  };
}

export function decodeMemoryCitation(value: unknown): MemoryCitation {
  return decodeOpenVikingCitation(value);
}

export function decodeOpenVikingCitationList(value: unknown): OpenVikingCitation[] {
  if (!Array.isArray(value)) throw new Error("invalid openviking citation list");
  return value.map(decodeOpenVikingCitation);
}
