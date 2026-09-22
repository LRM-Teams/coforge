import type { PrismaClient } from "../../../../generated/client";
import {
  isIntegrityConstraintError,
  isUniqueConstraintError,
  WorkspaceMemoryCitationKindError,
  WorkspaceMemoryReplayConflictError,
} from "./workspace-memory-errors.server";

export const MEMORY_CITATION_KINDS = ["openviking", "causal_memory"] as const;
export type MemoryCitationKind = (typeof MEMORY_CITATION_KINDS)[number];

export const OPENVIKING_MATCHED_LEVELS = ["L0", "L1", "L2"] as const;
export type OpenVikingMatchedLevel = (typeof OPENVIKING_MATCHED_LEVELS)[number];

export type OpenVikingCitationRecord = {
  workspaceId: string;
  citationId: string;
  accountId: string;
  uri: string;
  contentHash?: string;
  contentVersion?: string;
  matchedLevel: OpenVikingMatchedLevel;
  title?: string;
  excerpt?: string;
  boundOperationId: string;
};

export type MemoryOfferCitationRef =
  | { kind: "openviking"; citationId: string }
  | { kind: "causal_memory"; citationId: string };

export type MemoryOfferRecord = {
  workspaceId: string;
  operationId: string;
  conversationId: string;
  recipientAgentId: string;
  recipientRationale: string;
  messageId: string;
  citations: MemoryOfferCitationRef[];
};

export type PutOfferResult =
  | { outcome: "saved"; offer: MemoryOfferRecord }
  | { outcome: "replay"; offer: MemoryOfferRecord };

export type WorkspaceMemoryCitationStore = {
  putOpenVikingCitation(record: OpenVikingCitationRecord): Promise<OpenVikingCitationRecord>;
  getOpenVikingCitation(
    workspaceId: string,
    citationId: string,
  ): Promise<OpenVikingCitationRecord | null>;
  putOffer(input: MemoryOfferRecord): Promise<PutOfferResult>;
  getOffer(workspaceId: string, operationId: string): Promise<MemoryOfferRecord | null>;
};

type OpenVikingCitationRow = {
  workspaceId: string;
  citationId: string;
  accountId: string;
  uri: string;
  contentHash: string | null;
  contentVersion: string | null;
  matchedLevel: string;
  title: string | null;
  excerpt: string | null;
  boundOperationId: string;
};

type OfferRow = {
  workspaceId: string;
  operationId: string;
  conversationId: string;
  recipientAgentId: string;
  recipientRationale: string;
  messageId: string;
  citations: { citationKind: string; citationId: string }[];
};

export class PrismaWorkspaceMemoryCitationStore implements WorkspaceMemoryCitationStore {
  constructor(private readonly db: PrismaClient) {}

  async putOpenVikingCitation(record: OpenVikingCitationRecord): Promise<OpenVikingCitationRecord> {
    const data = citationColumns(record);
    const row = await this.db.openVikingCitationRecord.upsert({
      where: {
        workspaceId_citationId: { workspaceId: record.workspaceId, citationId: record.citationId },
      },
      create: data,
      update: {
        accountId: data.accountId,
        uri: data.uri,
        contentHash: data.contentHash,
        contentVersion: data.contentVersion,
        matchedLevel: data.matchedLevel,
        title: data.title,
        excerpt: data.excerpt,
        boundOperationId: data.boundOperationId,
      },
    });
    return toCitation(row);
  }

  async getOpenVikingCitation(
    workspaceId: string,
    citationId: string,
  ): Promise<OpenVikingCitationRecord | null> {
    const row = await this.db.openVikingCitationRecord.findUnique({
      where: { workspaceId_citationId: { workspaceId, citationId } },
    });
    return row ? toCitation(row) : null;
  }

  async putOffer(input: MemoryOfferRecord): Promise<PutOfferResult> {
    if (input.citations.length === 0) throw new WorkspaceMemoryCitationKindError();
    await this.assertCitationKindIntegrity(input);
    const existing = await this.db.memoryOfferRecord.findUnique({
      where: {
        workspaceId_operationId: { workspaceId: input.workspaceId, operationId: input.operationId },
      },
      include: { citations: { orderBy: [{ citationKind: "asc" }, { citationId: "asc" }] } },
    });
    if (existing) {
      if (!sameOffer(toOffer(existing), input)) {
        throw new WorkspaceMemoryReplayConflictError(input.operationId);
      }
      return { outcome: "replay", offer: toOffer(existing) };
    }
    try {
      const row = await this.db.memoryOfferRecord.create({
        data: {
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          conversationId: input.conversationId,
          recipientAgentId: input.recipientAgentId,
          recipientRationale: input.recipientRationale,
          messageId: input.messageId,
          citations: {
            create: input.citations.map((citation) => ({
              citationKind: citation.kind,
              citationId: citation.citationId,
              openvikingCitationId: citation.kind === "openviking" ? citation.citationId : null,
              causalCitationId: citation.kind === "causal_memory" ? citation.citationId : null,
            })),
          },
        },
        include: { citations: { orderBy: [{ citationKind: "asc" }, { citationId: "asc" }] } },
      });
      return { outcome: "saved", offer: toOffer(row) };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const replayed = await this.getOffer(input.workspaceId, input.operationId);
        if (replayed && sameOffer(replayed, input)) return { outcome: "replay", offer: replayed };
        throw new WorkspaceMemoryReplayConflictError(input.operationId);
      }
      if (isIntegrityConstraintError(error)) throw new WorkspaceMemoryCitationKindError();
      throw error;
    }
  }

  async getOffer(workspaceId: string, operationId: string): Promise<MemoryOfferRecord | null> {
    const row = await this.db.memoryOfferRecord.findUnique({
      where: { workspaceId_operationId: { workspaceId, operationId } },
      include: { citations: { orderBy: [{ citationKind: "asc" }, { citationId: "asc" }] } },
    });
    return row ? toOffer(row) : null;
  }

  private async assertCitationKindIntegrity(input: MemoryOfferRecord): Promise<void> {
    for (const citation of input.citations) {
      if (citation.kind === "openviking") {
        const record = await this.db.openVikingCitationRecord.findUnique({
          where: {
            workspaceId_citationId: {
              workspaceId: input.workspaceId,
              citationId: citation.citationId,
            },
          },
          select: { citationId: true },
        });
        if (!record) throw new WorkspaceMemoryCitationKindError();
        continue;
      }
      if (citation.kind === "causal_memory") {
        const record = await this.db.causalCitationRecord.findUnique({
          where: {
            workspaceId_citationId: {
              workspaceId: input.workspaceId,
              citationId: citation.citationId,
            },
          },
          select: { citationId: true },
        });
        if (!record) throw new WorkspaceMemoryCitationKindError();
        continue;
      }
      throw new WorkspaceMemoryCitationKindError();
    }
  }
}

function citationColumns(record: OpenVikingCitationRecord) {
  if (!(OPENVIKING_MATCHED_LEVELS as readonly string[]).includes(record.matchedLevel)) {
    throw new WorkspaceMemoryCitationKindError();
  }
  if (!record.contentHash && !record.contentVersion) throw new WorkspaceMemoryCitationKindError();
  if (!record.title && !record.excerpt) throw new WorkspaceMemoryCitationKindError();
  return {
    workspaceId: record.workspaceId,
    citationId: record.citationId,
    accountId: record.accountId,
    uri: record.uri,
    contentHash: record.contentHash ?? null,
    contentVersion: record.contentVersion ?? null,
    matchedLevel: record.matchedLevel,
    title: record.title ?? null,
    excerpt: record.excerpt ?? null,
    boundOperationId: record.boundOperationId,
  };
}

function toCitation(row: OpenVikingCitationRow): OpenVikingCitationRecord {
  if (!(OPENVIKING_MATCHED_LEVELS as readonly string[]).includes(row.matchedLevel)) {
    throw new WorkspaceMemoryCitationKindError();
  }
  return {
    workspaceId: row.workspaceId,
    citationId: row.citationId,
    accountId: row.accountId,
    uri: row.uri,
    ...(row.contentHash ? { contentHash: row.contentHash } : {}),
    ...(row.contentVersion ? { contentVersion: row.contentVersion } : {}),
    matchedLevel: row.matchedLevel as OpenVikingMatchedLevel,
    ...(row.title ? { title: row.title } : {}),
    ...(row.excerpt ? { excerpt: row.excerpt } : {}),
    boundOperationId: row.boundOperationId,
  };
}

function toOffer(row: OfferRow): MemoryOfferRecord {
  return {
    workspaceId: row.workspaceId,
    operationId: row.operationId,
    conversationId: row.conversationId,
    recipientAgentId: row.recipientAgentId,
    recipientRationale: row.recipientRationale,
    messageId: row.messageId,
    citations: row.citations.map((citation) => {
      if (!(MEMORY_CITATION_KINDS as readonly string[]).includes(citation.citationKind)) {
        throw new WorkspaceMemoryCitationKindError();
      }
      return {
        kind: citation.citationKind as MemoryCitationKind,
        citationId: citation.citationId,
      };
    }),
  };
}

function citationKey(citation: MemoryOfferCitationRef): string {
  return `${citation.kind}:${citation.citationId}`;
}

function sameOffer(stored: MemoryOfferRecord, incoming: MemoryOfferRecord): boolean {
  const storedKeys = stored.citations.map(citationKey).toSorted();
  const incomingKeys = incoming.citations.map(citationKey).toSorted();
  return (
    stored.conversationId === incoming.conversationId &&
    stored.recipientAgentId === incoming.recipientAgentId &&
    stored.recipientRationale === incoming.recipientRationale &&
    stored.messageId === incoming.messageId &&
    storedKeys.length === incomingKeys.length &&
    storedKeys.every((key, index) => key === incomingKeys[index])
  );
}
