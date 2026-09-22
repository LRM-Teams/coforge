/**
 * F4 dual-citation binding. New code uses tagged MemoryCitation variants.
 * Unversioned CausalCitation stays on the pre-F4 causal slice only.
 */

import {
  CAUSAL_MEMORY_CITATION_KIND,
  decodeCausalCorrectionEvidence,
  decodeCausalMemoryCitation,
  decodeMemoryCitation,
  decodeOpenVikingCitation,
  OPENVIKING_CITATION_KIND,
  type CausalMemoryCitation,
  type MemoryCitation,
  type OpenVikingCitation,
} from "@lrm/coforge-sdk/agent";
import type { CausalCitationRecord } from "./contract";
import type {
  MemoryOfferCitationRef,
  OpenVikingCitationRecord,
  WorkspaceMemoryCitationStore,
} from "../db/repositories/workspace-memory-citation.repositories.server";

export class MemoryCitationUngroundedError extends Error {
  constructor(message = "citation was not served") {
    super(message);
    this.name = "MemoryCitationUngroundedError";
  }
}

export class MemoryCitationCorrectionError extends Error {
  constructor(message = "openviking citation cannot satisfy causal correction") {
    super(message);
    this.name = "MemoryCitationCorrectionError";
  }
}

/** R1.2 HydratedFact + AdmittedProvenance, camelCased at the Web seam. */
export type HydratedCausalHit = {
  citationId: string;
  causalItemId: string;
  causalPathId?: string;
  factVersion: number;
  admittedSegmentId: string;
  sourceMessageIds: string[];
  displayContent: string;
};

export type CausalMemoryCitationRecord = CausalMemoryCitation & {
  workspaceId: string;
  boundOperationId: string;
};

export type CausalMemoryCitationBindings = {
  put(record: CausalMemoryCitationRecord): Promise<CausalMemoryCitationRecord>;
  get(workspaceId: string, citationId: string): Promise<CausalMemoryCitationRecord | null>;
};

export type MemoryCitationBindings = {
  bindOpenVikingHits(
    workspaceId: string,
    operationId: string,
    hits: unknown[],
  ): Promise<OpenVikingCitation[]>;
  bindCausalHits(
    workspaceId: string,
    operationId: string,
    hits: unknown[],
  ): Promise<CausalMemoryCitation[]>;
  resolveOfferCitations(workspaceId: string, citationRefs: string[]): Promise<MemoryCitation[]>;
  resolveCorrectionEvidence(
    workspaceId: string,
    citationRefs: string[],
  ): Promise<CausalMemoryCitation[]>;
  toOfferRefs(citations: readonly MemoryCitation[]): MemoryOfferCitationRef[];
};

export function createPrismaCausalMemoryCitationBindings(repo: {
  putCitation(input: CausalCitationRecord): Promise<CausalCitationRecord>;
  getCitation(workspaceId: string, citationId: string): Promise<CausalCitationRecord | undefined>;
}): CausalMemoryCitationBindings {
  return {
    async put(record) {
      const citation = decodeCausalMemoryCitation(record);
      await repo.putCitation({
        workspaceId: record.workspaceId,
        citationId: citation.citationId,
        causalItemId: citation.causalItemId,
        causalPathId: citation.causalPathId,
        factVersion: citation.factVersion,
        admittedSegmentId: citation.admittedSegmentId,
        sourceMessageIds: citation.sourceMessageIds,
        boundOperationId: record.boundOperationId,
        displayContent: citation.displayContent,
      });
      return {
        ...citation,
        workspaceId: record.workspaceId,
        boundOperationId: record.boundOperationId,
      };
    },
    async get(workspaceId, citationId) {
      const row = await repo.getCitation(workspaceId, citationId);
      if (!row) return null;
      if (row.factVersion === undefined || row.factVersion === null) return null;
      try {
        const citation = decodeCausalMemoryCitation({
          kind: CAUSAL_MEMORY_CITATION_KIND,
          citationId: row.citationId,
          causalItemId: row.causalItemId,
          ...(row.causalPathId === undefined ? {} : { causalPathId: row.causalPathId }),
          factVersion: row.factVersion,
          admittedSegmentId: row.admittedSegmentId,
          sourceMessageIds: row.sourceMessageIds,
          displayContent: row.displayContent ?? "",
        });
        return {
          ...citation,
          workspaceId: row.workspaceId,
          boundOperationId: row.boundOperationId,
        };
      } catch {
        return null;
      }
    },
  };
}

export function createInMemoryCausalMemoryCitationBindings(): CausalMemoryCitationBindings {
  const rows = new Map<string, CausalMemoryCitationRecord>();
  return {
    async put(record) {
      const citation = decodeCausalMemoryCitation(record);
      const stored = {
        ...citation,
        workspaceId: record.workspaceId,
        boundOperationId: record.boundOperationId,
      };
      rows.set(`${record.workspaceId}:${record.citationId}`, stored);
      return stored;
    },
    async get(workspaceId, citationId) {
      return rows.get(`${workspaceId}:${citationId}`) ?? null;
    },
  };
}

export function createMemoryCitationBindings(deps: {
  openviking: Pick<WorkspaceMemoryCitationStore, "putOpenVikingCitation" | "getOpenVikingCitation">;
  causal: CausalMemoryCitationBindings;
}): MemoryCitationBindings {
  return {
    async bindOpenVikingHits(workspaceId, operationId, hits) {
      const citations: OpenVikingCitation[] = [];
      for (const hit of hits) {
        const citation = decodeOpenVikingHit(workspaceId, hit);
        await deps.openviking.putOpenVikingCitation({
          workspaceId,
          citationId: citation.citationId,
          accountId: citation.accountId,
          uri: citation.uri,
          ...(citation.contentHash === undefined ? {} : { contentHash: citation.contentHash }),
          ...(citation.contentVersion === undefined
            ? {}
            : { contentVersion: citation.contentVersion }),
          matchedLevel: citation.matchedLevel,
          ...(citation.title === undefined ? {} : { title: citation.title }),
          ...(citation.excerpt === undefined ? {} : { excerpt: citation.excerpt }),
          boundOperationId: operationId,
        });
        citations.push(citation);
      }
      return citations;
    },

    async bindCausalHits(workspaceId, operationId, hits) {
      const citations: CausalMemoryCitation[] = [];
      for (const hit of hits) {
        const citation = decodeHydratedCausalHit(hit);
        await deps.causal.put({
          ...citation,
          workspaceId,
          boundOperationId: operationId,
        });
        citations.push(citation);
      }
      return citations;
    },

    async resolveOfferCitations(workspaceId, citationRefs) {
      if (citationRefs.length === 0)
        throw new MemoryCitationUngroundedError("invalid offer citations");
      const citations: MemoryCitation[] = [];
      for (const citationId of citationRefs) {
        citations.push(await requireServedCitation(deps, workspaceId, citationId));
      }
      return citations;
    },

    async resolveCorrectionEvidence(workspaceId, citationRefs) {
      const citations = await Promise.all(
        citationRefs.map((citationId) => requireServedCitation(deps, workspaceId, citationId)),
      );
      try {
        return decodeCausalCorrectionEvidence(citations);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "invalid causal correction evidence";
        if (message.includes("openviking")) throw new MemoryCitationCorrectionError(message);
        throw new MemoryCitationUngroundedError(message);
      }
    },

    toOfferRefs(citations) {
      return citations.map((citation) =>
        citation.kind === OPENVIKING_CITATION_KIND
          ? { kind: OPENVIKING_CITATION_KIND, citationId: citation.citationId }
          : { kind: CAUSAL_MEMORY_CITATION_KIND, citationId: citation.citationId },
      );
    },
  };
}

export function openVikingRecordToCitation(record: OpenVikingCitationRecord): OpenVikingCitation {
  return decodeOpenVikingCitation({
    kind: OPENVIKING_CITATION_KIND,
    citationId: record.citationId,
    workspaceId: record.workspaceId,
    accountId: record.accountId,
    uri: record.uri,
    ...(record.contentHash === undefined ? {} : { contentHash: record.contentHash }),
    ...(record.contentVersion === undefined ? {} : { contentVersion: record.contentVersion }),
    matchedLevel: record.matchedLevel,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.excerpt === undefined ? {} : { excerpt: record.excerpt }),
  });
}

function decodeHydratedCausalHit(value: unknown): CausalMemoryCitation {
  if (!value || typeof value !== "object") throw new MemoryCitationUngroundedError();
  const hit = value as Record<string, unknown>;
  try {
    return decodeCausalMemoryCitation({
      kind: CAUSAL_MEMORY_CITATION_KIND,
      citationId: hit.citationId,
      causalItemId: hit.causalItemId ?? hit.factId,
      ...(hit.causalPathId === undefined ? {} : { causalPathId: hit.causalPathId }),
      factVersion: hit.factVersion ?? hit.fact_version,
      admittedSegmentId: hit.admittedSegmentId ?? hit.admitted_segment_id,
      sourceMessageIds: hit.sourceMessageIds ?? hit.source_message_ids,
      displayContent: hit.displayContent ?? hit.content,
    });
  } catch (error) {
    throw new MemoryCitationUngroundedError(
      error instanceof Error ? error.message : "invalid causal memory citation",
    );
  }
}

function decodeOpenVikingHit(workspaceId: string, value: unknown): OpenVikingCitation {
  if (!value || typeof value !== "object") throw new MemoryCitationUngroundedError();
  const hit = value as Record<string, unknown>;
  const uri = nonempty(hit.uri);
  if (!uri) throw new MemoryCitationUngroundedError("invalid openviking uri");
  const matchedLevel = hit.matchedLevel ?? hit.matched_level ?? hit.level;
  const contentHash = hit.contentHash ?? hit.content_hash;
  const contentVersion = hit.contentVersion ?? hit.content_version;
  const excerpt = hit.excerpt ?? hit.snippet ?? hit.summary;
  try {
    return decodeOpenVikingCitation({
      kind: OPENVIKING_CITATION_KIND,
      citationId: nonempty(hit.citationId) ?? nonempty(hit.citation_id) ?? `ov:${uri}`,
      workspaceId: nonempty(hit.workspaceId) ?? workspaceId,
      accountId: nonempty(hit.accountId) ?? nonempty(hit.account_id),
      uri,
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(contentVersion === undefined ? {} : { contentVersion }),
      matchedLevel,
      ...(hit.title === undefined ? {} : { title: hit.title }),
      ...(excerpt === undefined ? {} : { excerpt }),
    });
  } catch (error) {
    throw new MemoryCitationUngroundedError(
      error instanceof Error ? error.message : "invalid openviking citation",
    );
  }
}

async function requireServedCitation(
  deps: {
    openviking: Pick<WorkspaceMemoryCitationStore, "getOpenVikingCitation">;
    causal: CausalMemoryCitationBindings;
  },
  workspaceId: string,
  citationId: string,
): Promise<MemoryCitation> {
  const causal = await deps.causal.get(workspaceId, citationId);
  if (causal) return decodeMemoryCitation(causal);
  const openviking = await deps.openviking.getOpenVikingCitation(workspaceId, citationId);
  if (openviking) return openVikingRecordToCitation(openviking);
  throw new MemoryCitationUngroundedError();
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
