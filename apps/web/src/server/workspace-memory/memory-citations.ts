/**
 * Workspace memory citation binding. A citation is a versioned OpenViking
 * object reference served earlier in this Workspace; offers may only cite
 * citations that were served.
 */

import {
  decodeOpenVikingCitation,
  OPENVIKING_CITATION_KIND,
  type MemoryCitation,
  type OpenVikingCitation,
} from "@lrm/coforge-sdk/agent";
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

export type MemoryCitationBindings = {
  bindOpenVikingHits(
    workspaceId: string,
    operationId: string,
    hits: unknown[],
  ): Promise<OpenVikingCitation[]>;
  resolveOfferCitations(workspaceId: string, citationRefs: string[]): Promise<MemoryCitation[]>;
  toOfferRefs(citations: readonly MemoryCitation[]): MemoryOfferCitationRef[];
};

export function createMemoryCitationBindings(deps: {
  openviking: Pick<WorkspaceMemoryCitationStore, "putOpenVikingCitation" | "getOpenVikingCitation">;
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

    async resolveOfferCitations(workspaceId, citationRefs) {
      if (citationRefs.length === 0)
        throw new MemoryCitationUngroundedError("invalid offer citations");
      const citations: MemoryCitation[] = [];
      for (const citationId of citationRefs) {
        const record = await deps.openviking.getOpenVikingCitation(workspaceId, citationId);
        if (!record) throw new MemoryCitationUngroundedError();
        citations.push(openVikingRecordToCitation(record));
      }
      return citations;
    },

    toOfferRefs(citations) {
      return citations.map((citation) => ({
        kind: OPENVIKING_CITATION_KIND,
        citationId: citation.citationId,
      }));
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

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
