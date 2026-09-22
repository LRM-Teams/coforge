/**
 * Tagged Memory Agent citation contract (C2 freeze).
 *
 * OpenViking and Causal Memory citations are distinct evidence types. An
 * OpenViking URI never stands in for admitted causal provenance, and only a
 * versioned Causal Memory Citation may satisfy a Causal Correction Proposal.
 */

export const OPENVIKING_CITATION_KIND = "openviking" as const;
export const CAUSAL_MEMORY_CITATION_KIND = "causal_memory" as const;

export const OPENVIKING_MATCHED_LEVELS = ["L0", "L1", "L2"] as const;
export type OpenVikingMatchedLevel = (typeof OPENVIKING_MATCHED_LEVELS)[number];

const CAUSAL_ONLY_FIELDS = [
  "causalItemId",
  "causalPathId",
  "factVersion",
  "admittedSegmentId",
  "sourceMessageIds",
] as const;

const OPENVIKING_ONLY_FIELDS = [
  "uri",
  "accountId",
  "contentHash",
  "contentVersion",
  "matchedLevel",
  "title",
  "excerpt",
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

export type CausalMemoryCitation = {
  kind: typeof CAUSAL_MEMORY_CITATION_KIND;
  citationId: string;
  causalItemId: string;
  causalPathId?: string;
  factVersion: number;
  admittedSegmentId: string;
  sourceMessageIds: string[];
  displayContent: string;
};

export type MemoryCitation = OpenVikingCitation | CausalMemoryCitation;
export type CausalCorrectionEvidence = readonly CausalMemoryCitation[];

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

export function isCausalMemoryCitation(value: unknown): value is CausalMemoryCitation {
  try {
    decodeCausalMemoryCitation(value);
    return true;
  } catch {
    return false;
  }
}

export function decodeOpenVikingCitation(value: unknown): OpenVikingCitation {
  if (!value || typeof value !== "object") throw new Error("invalid memory citation");
  const citation = value as Record<string, unknown>;
  if (citation.kind !== OPENVIKING_CITATION_KIND) throw new Error("invalid memory citation kind");
  rejectMixedFields(citation, CAUSAL_ONLY_FIELDS, "openviking");
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

export function decodeCausalMemoryCitation(value: unknown): CausalMemoryCitation {
  if (!value || typeof value !== "object") throw new Error("invalid memory citation");
  const citation = value as Record<string, unknown>;
  if (citation.kind !== CAUSAL_MEMORY_CITATION_KIND)
    throw new Error("invalid memory citation kind");
  rejectMixedFields(citation, OPENVIKING_ONLY_FIELDS, "causal_memory");
  if (!isNonEmptyString(citation.citationId)) throw new Error("invalid causal memory citationId");
  if (!isNonEmptyString(citation.causalItemId)) throw new Error("invalid causal memory item");
  if (citation.causalPathId !== undefined && typeof citation.causalPathId !== "string")
    throw new Error("invalid causal memory path");
  const factVersion = citation.factVersion;
  if (typeof factVersion !== "number" || !Number.isInteger(factVersion) || factVersion < 1)
    throw new Error("unversioned causal memory citation");
  if (!isNonEmptyString(citation.admittedSegmentId))
    throw new Error("invalid causal memory admittedSegmentId");
  const sourceMessageIds = citation.sourceMessageIds;
  if (
    !Array.isArray(sourceMessageIds) ||
    sourceMessageIds.length === 0 ||
    !sourceMessageIds.every(isNonEmptyString)
  )
    throw new Error("invalid causal memory sourceMessageIds");
  if (typeof citation.displayContent !== "string")
    throw new Error("invalid causal memory displayContent");

  return {
    kind: CAUSAL_MEMORY_CITATION_KIND,
    citationId: citation.citationId,
    causalItemId: citation.causalItemId,
    ...(citation.causalPathId === undefined ? {} : { causalPathId: citation.causalPathId }),
    factVersion,
    admittedSegmentId: citation.admittedSegmentId,
    sourceMessageIds,
    displayContent: citation.displayContent,
  };
}

export function decodeMemoryCitation(value: unknown): MemoryCitation {
  if (!value || typeof value !== "object") throw new Error("invalid memory citation");
  const kind = (value as { kind?: unknown }).kind;
  if (kind === OPENVIKING_CITATION_KIND) return decodeOpenVikingCitation(value);
  if (kind === CAUSAL_MEMORY_CITATION_KIND) return decodeCausalMemoryCitation(value);
  throw new Error("invalid memory citation kind");
}

export function decodeCausalCorrectionEvidence(value: unknown): CausalMemoryCitation[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("invalid causal correction evidence");
  return value.map((item) => {
    const citation = decodeMemoryCitation(item);
    if (citation.kind !== CAUSAL_MEMORY_CITATION_KIND)
      throw new Error("openviking citation cannot satisfy causal correction");
    return citation;
  });
}
