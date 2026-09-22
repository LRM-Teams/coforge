/**
 * Memory Agent OpenViking reads. Hits become OpenVikingCitation records;
 * this module never writes OpenViking and never holds OpenViking HTTP paths.
 */

import { OPENVIKING_CANDIDATE_LIMIT_MAX, type OpenVikingCitation } from "@lrm/coforge-sdk/agent";
import { MemoryCitationUngroundedError, type MemoryCitationBindings } from "./memory-citations";
import type { OpenVikingMemoryReadClient } from "../openviking/memory-agent-reads";

export { MemoryAgentMutationError } from "../openviking/memory-agent-reads";
export type { OpenVikingMemoryReadClient } from "../openviking/memory-agent-reads";

export type OpenVikingMemoryReads = {
  find(input: {
    workspaceId: string;
    agentId: string;
    operationId: string;
    query: string;
    limit?: number;
    targetUri?: string;
  }): Promise<OpenVikingCitation[]>;
  searchContext(input: {
    workspaceId: string;
    agentId: string;
    operationId: string;
    query: string;
    limit?: number;
    targetUri?: string;
    tokenBudget?: number;
  }): Promise<OpenVikingCitation[]>;
  read(input: {
    workspaceId: string;
    agentId: string;
    operationId: string;
    uri: string;
  }): Promise<{ citation: OpenVikingCitation; content: string }>;
};

export function createOpenVikingMemoryReads(deps: {
  client: OpenVikingMemoryReadClient;
  citations: MemoryCitationBindings;
}): OpenVikingMemoryReads {
  return {
    async find(input) {
      const payload = await deps.client.invoke({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operation: "find",
        body: {
          query: input.query,
          limit: input.limit ?? OPENVIKING_CANDIDATE_LIMIT_MAX,
          ...(input.targetUri === undefined ? {} : { target_uri: input.targetUri }),
        },
      });
      return deps.citations.bindOpenVikingHits(
        input.workspaceId,
        input.operationId,
        collectHits(payload, input.workspaceId),
      );
    },

    async searchContext(input) {
      const payload = await deps.client.invoke({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operation: "search_context",
        body: {
          query: input.query,
          limit: input.limit ?? OPENVIKING_CANDIDATE_LIMIT_MAX,
          query_expansion: "off",
          ...(input.targetUri === undefined ? {} : { target_uri: input.targetUri }),
          ...(input.tokenBudget === undefined ? {} : { token_budget: input.tokenBudget }),
        },
      });
      return deps.citations.bindOpenVikingHits(
        input.workspaceId,
        input.operationId,
        collectHits(payload, input.workspaceId),
      );
    },

    async read(input) {
      const payload = await deps.client.invoke({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operation: "read",
        query: { uri: input.uri },
      });
      const hit = asReadHit(payload, input);
      const [citation] = await deps.citations.bindOpenVikingHits(
        input.workspaceId,
        input.operationId,
        [hit],
      );
      if (!citation) throw new MemoryCitationUngroundedError();
      return { citation, content: hit.content };
    },
  };
}

function collectHits(payload: unknown, workspaceId: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const hits = record.results ?? record.items ?? record.resources;
  return Array.isArray(hits)
    ? hits.map((hit) => annotateWorkspace(hit, workspaceId))
    : [annotateWorkspace(payload, workspaceId)];
}

function asReadHit(
  payload: unknown,
  input: { workspaceId: string; uri: string },
): Record<string, unknown> & { content: string } {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.body === "string"
        ? record.body
        : "";
  const uri = typeof record.uri === "string" ? record.uri : input.uri;
  return {
    ...record,
    workspaceId: input.workspaceId,
    uri,
    content,
    contentHash:
      record.contentHash ?? record.content_hash ?? (content ? contentSha256(content) : undefined),
    excerpt: record.excerpt ?? record.snippet ?? record.summary ?? content.slice(0, 200),
    matchedLevel: record.matchedLevel ?? record.matched_level ?? record.level ?? "L2",
    citationId: record.citationId ?? record.citation_id ?? `ov:${uri}`,
  };
}

function annotateWorkspace(value: unknown, workspaceId: string): unknown {
  if (!value || typeof value !== "object") return value;
  const hit = value as Record<string, unknown>;
  return { workspaceId, ...hit };
}

function contentSha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return `sha256:${hasher.digest("hex")}`;
}
