import type { PrismaClient } from "../../../../generated/client";
import {
  type AdmittedSegmentIngestLedger,
  type CausalCitationRecord,
  type CausalCorrectionProposalRecord,
  type CausalOfferRecord,
  type CausalSupersessionResult,
  type CausalWorkspaceTenant,
  type IngestLedgerState,
} from "../../causal-memory/contract";

export class CausalReplayConflictError extends Error {
  constructor(readonly operationId: string) {
    super(`causal operation ${operationId} drifted`);
    this.name = "CausalReplayConflictError";
  }
}

export class CausalWorkspaceScopeError extends Error {
  constructor() {
    super("cross-workspace causal reference is rejected");
    this.name = "CausalWorkspaceScopeError";
  }
}

export class PrismaCausalMemoryRepository {
  constructor(private readonly db: PrismaClient) {}

  async putTenant(input: CausalWorkspaceTenant): Promise<CausalWorkspaceTenant> {
    const row = await this.db.causalWorkspaceTenant.upsert({
      where: { workspaceId: input.workspaceId },
      create: {
        workspaceId: input.workspaceId,
        tenantId: input.tenantId,
        enabled: input.enabled,
        memoryAgentId: input.memoryAgentId,
      },
      update: {
        tenantId: input.tenantId,
        enabled: input.enabled,
        ...(input.memoryAgentId === undefined ? {} : { memoryAgentId: input.memoryAgentId }),
      },
    });
    return this.toTenant(row);
  }

  async ensureTenant(workspaceId: string): Promise<CausalWorkspaceTenant> {
    const existing = await this.getTenant(workspaceId);
    if (existing) return existing;
    return this.putTenant({ workspaceId, tenantId: workspaceId, enabled: true });
  }

  async getTenant(workspaceId: string): Promise<CausalWorkspaceTenant | undefined> {
    const row = await this.db.causalWorkspaceTenant.findUnique({ where: { workspaceId } });
    return row ? this.toTenant(row) : undefined;
  }

  async listEnabledTenants(): Promise<CausalWorkspaceTenant[]> {
    const rows = await this.db.causalWorkspaceTenant.findMany({ where: { enabled: true } });
    return rows.map((row) => this.toTenant(row));
  }

  async designatedMemoryAgent(
    workspaceId: string,
  ): Promise<{ tenantId: string; enabled: boolean; memoryAgentId: string | null } | undefined> {
    const row = await this.db.causalWorkspaceTenant.findUnique({ where: { workspaceId } });
    return row
      ? { tenantId: row.tenantId, enabled: row.enabled, memoryAgentId: row.memoryAgentId }
      : undefined;
  }

  async putPendingLedger(input: AdmittedSegmentIngestLedger): Promise<AdmittedSegmentIngestLedger> {
    const existing = await this.db.admittedSegmentIngestLedger.findUnique({
      where: {
        workspaceId_operationId: { workspaceId: input.workspaceId, operationId: input.operationId },
      },
    });
    if (existing) {
      if (
        existing.sourcePayloadHash !== input.sourcePayloadHash ||
        existing.admittedSegmentId !== input.admittedSegmentId
      )
        throw new CausalReplayConflictError(input.operationId);
      return this.toLedger(existing);
    }
    const row = await this.db.admittedSegmentIngestLedger.create({
      data: {
        workspaceId: input.workspaceId,
        admittedSegmentId: input.admittedSegmentId,
        operationId: input.operationId,
        kind: input.kind,
        sourceMessageIds: input.sourceMessageIds,
        sourcePayloadHash: input.sourcePayloadHash,
        state: input.state,
        attemptCount: input.attemptCount,
        sanitizedError: input.sanitizedError,
        sources: {
          create: input.sourceMessageIds.map((messageId) => ({
            messageId,
            payloadHash: input.sourcePayloadHash,
          })),
        },
      },
    });
    return this.toLedger(row);
  }

  async markLedgerState(
    workspaceId: string,
    operationId: string,
    state: IngestLedgerState,
    sanitizedError?: string,
  ): Promise<AdmittedSegmentIngestLedger> {
    const existing = await this.db.admittedSegmentIngestLedger.findUnique({
      where: { workspaceId_operationId: { workspaceId, operationId } },
    });
    if (!existing) throw new CausalWorkspaceScopeError();
    const row = await this.db.admittedSegmentIngestLedger.update({
      where: { workspaceId_operationId: { workspaceId, operationId } },
      data: {
        state,
        sanitizedError,
        attemptCount:
          state === "temporary_failure" ? existing.attemptCount + 1 : existing.attemptCount,
      },
    });
    return this.toLedger(row);
  }

  async listRetryableLedgers(workspaceId: string): Promise<AdmittedSegmentIngestLedger[]> {
    const rows = await this.db.admittedSegmentIngestLedger.findMany({
      where: { workspaceId, state: { in: ["pending", "temporary_failure"] } },
    });
    return rows.map((row) => this.toLedger(row));
  }

  async listAdmittedMessageIds(workspaceId: string): Promise<Set<string>> {
    const rows = await this.db.segmentSourceMessage.findMany({
      where: { workspaceId },
      select: { messageId: true },
    });
    return new Set(rows.map((row) => row.messageId));
  }

  async putCitation(input: CausalCitationRecord): Promise<CausalCitationRecord> {
    const tenant = await this.db.causalWorkspaceTenant.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!tenant) throw new CausalWorkspaceScopeError();
    const row = await this.db.causalCitationRecord.upsert({
      where: {
        workspaceId_citationId: { workspaceId: input.workspaceId, citationId: input.citationId },
      },
      create: {
        workspaceId: input.workspaceId,
        citationId: input.citationId,
        causalItemId: input.causalItemId,
        causalPathId: input.causalPathId,
        admittedSegmentId: input.admittedSegmentId,
        sourceMessageIds: input.sourceMessageIds,
        boundOperationId: input.boundOperationId,
        displayContent: input.displayContent ?? "",
      },
      update: {
        causalItemId: input.causalItemId,
        causalPathId: input.causalPathId,
        admittedSegmentId: input.admittedSegmentId,
        sourceMessageIds: input.sourceMessageIds,
        boundOperationId: input.boundOperationId,
        displayContent: input.displayContent ?? "",
      },
    });
    return this.toCitation(row);
  }

  async getCitation(
    workspaceId: string,
    citationId: string,
  ): Promise<CausalCitationRecord | undefined> {
    const row = await this.db.causalCitationRecord.findUnique({
      where: { workspaceId_citationId: { workspaceId, citationId } },
    });
    return row ? this.toCitation(row) : undefined;
  }

  async putOffer(input: CausalOfferRecord): Promise<CausalOfferRecord> {
    const existing = await this.db.causalOfferRecord.findUnique({
      where: {
        workspaceId_operationId: { workspaceId: input.workspaceId, operationId: input.operationId },
      },
    });
    if (existing) {
      if (
        existing.conversationId !== input.conversationId ||
        existing.recipientAgentId !== input.recipientAgentId ||
        existing.recipientRationale !== input.recipientRationale
      )
        throw new CausalReplayConflictError(input.operationId);
      return this.toOffer(existing);
    }
    const tenant = await this.db.causalWorkspaceTenant.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!tenant) throw new CausalWorkspaceScopeError();
    return this.toOffer(await this.db.causalOfferRecord.create({ data: input }));
  }

  async getOffer(workspaceId: string, operationId: string): Promise<CausalOfferRecord | undefined> {
    const row = await this.db.causalOfferRecord.findUnique({
      where: { workspaceId_operationId: { workspaceId, operationId } },
    });
    return row ? this.toOffer(row) : undefined;
  }

  async isActiveChannelAgent(
    workspaceId: string,
    conversationId: string,
    agentId: string,
  ): Promise<boolean> {
    const row = await this.db.conversationMember.findFirst({
      where: {
        workspaceId,
        conversationId,
        agentId,
        leftAt: null,
        conversation: { workspaceId, channelName: { not: null }, archivedAt: null },
      },
      select: { id: true },
    });
    return !!row;
  }

  async putProposal(
    input: CausalCorrectionProposalRecord,
  ): Promise<CausalCorrectionProposalRecord> {
    const existing = await this.db.causalCorrectionProposalRecord.findUnique({
      where: {
        workspaceId_operationId: { workspaceId: input.workspaceId, operationId: input.operationId },
      },
    });
    if (existing) {
      if (existing.causalItemId !== input.causalItemId)
        throw new CausalReplayConflictError(input.operationId);
      return this.toProposal(existing);
    }
    return this.toProposal(await this.db.causalCorrectionProposalRecord.create({ data: input }));
  }

  async putSupersession(input: CausalSupersessionResult): Promise<CausalSupersessionResult> {
    const proposal = await this.db.causalCorrectionProposalRecord.findUnique({
      where: {
        workspaceId_proposalId: { workspaceId: input.workspaceId, proposalId: input.proposalId },
      },
    });
    if (!proposal) throw new CausalWorkspaceScopeError();
    const row = await this.db.causalSupersessionResult.upsert({
      where: {
        workspaceId_proposalId: { workspaceId: input.workspaceId, proposalId: input.proposalId },
      },
      create: input,
      update: { verdict: input.verdict, superseded: input.superseded, auditId: input.auditId },
    });
    return {
      workspaceId: row.workspaceId,
      proposalId: row.proposalId,
      verdict: row.verdict as CausalSupersessionResult["verdict"],
      superseded: row.superseded,
      auditId: row.auditId,
    };
  }

  private toTenant(row: {
    workspaceId: string;
    tenantId: string;
    enabled: boolean;
    memoryAgentId: string | null;
  }): CausalWorkspaceTenant {
    return {
      workspaceId: row.workspaceId,
      tenantId: row.tenantId,
      enabled: row.enabled,
      ...(row.memoryAgentId ? { memoryAgentId: row.memoryAgentId } : {}),
    };
  }

  private toCitation(row: {
    workspaceId: string;
    citationId: string;
    causalItemId: string;
    causalPathId: string | null;
    admittedSegmentId: string;
    sourceMessageIds: string[];
    boundOperationId: string;
    displayContent: string;
  }): CausalCitationRecord {
    return {
      workspaceId: row.workspaceId,
      citationId: row.citationId,
      causalItemId: row.causalItemId,
      ...(row.causalPathId ? { causalPathId: row.causalPathId } : {}),
      admittedSegmentId: row.admittedSegmentId,
      sourceMessageIds: row.sourceMessageIds,
      boundOperationId: row.boundOperationId,
      displayContent: row.displayContent,
    };
  }

  private toProposal(row: {
    workspaceId: string;
    proposalId: string;
    operationId: string;
    causalItemId: string;
    contradictoryCitationIds: string[];
    rationale: string;
  }): CausalCorrectionProposalRecord {
    return {
      workspaceId: row.workspaceId,
      proposalId: row.proposalId,
      operationId: row.operationId,
      causalItemId: row.causalItemId,
      contradictoryCitationIds: row.contradictoryCitationIds,
      rationale: row.rationale,
    };
  }

  private toOffer(row: {
    workspaceId: string;
    operationId: string;
    conversationId: string;
    recipientAgentId: string;
    recipientRationale: string;
    messageId: string;
    citationIds: string[];
  }): CausalOfferRecord {
    return {
      workspaceId: row.workspaceId,
      operationId: row.operationId,
      conversationId: row.conversationId,
      recipientAgentId: row.recipientAgentId,
      recipientRationale: row.recipientRationale,
      messageId: row.messageId,
      citationIds: row.citationIds,
    };
  }

  private toLedger(row: {
    workspaceId: string;
    admittedSegmentId: string;
    operationId: string;
    kind: string;
    sourceMessageIds: string[];
    sourcePayloadHash: string;
    state: string;
    attemptCount: number;
    sanitizedError: string | null;
  }): AdmittedSegmentIngestLedger {
    return {
      workspaceId: row.workspaceId,
      admittedSegmentId: row.admittedSegmentId,
      operationId: row.operationId,
      kind: row.kind as AdmittedSegmentIngestLedger["kind"],
      sourceMessageIds: row.sourceMessageIds,
      sourcePayloadHash: row.sourcePayloadHash,
      state: row.state as IngestLedgerState,
      attemptCount: row.attemptCount,
      ...(row.sanitizedError ? { sanitizedError: row.sanitizedError } : {}),
    };
  }
}
