import {
  CAUSAL_OPERATION_ID_HEADER,
  CAUSAL_RUNTIME_PROTOCOL,
  CAUSAL_RUNTIME_ROUTES,
  isCausalRuntimeError,
  type AdmittedSegmentIngestLedger,
  type CausalAdjudicateRequest,
  type CausalAdjudicateResponse,
  type CausalAuditTurn,
  type CausalCitationRecord,
  type CausalInterveneRequest,
  type CausalMemoryModule,
  type CausalOfferRecord,
  type CausalReadResponse,
  type CausalRuntimeCitation,
  type CausalRuntimeError,
  type CausalSearchRequest,
  type CausalSessionIdentity,
  type CausalTraceRequest,
} from "./contract";
import {
  PrismaCausalMemoryRepository,
  CausalReplayConflictError,
  CausalWorkspaceScopeError,
} from "../db/repositories/causal-memory.repositories.server";
import type { CausalOfferPublisher } from "./offer-delivery.server";

export class CausalRuntimeRequestError extends Error {
  constructor(readonly code: CausalRuntimeError["error"]["code"]) {
    super(code);
    this.name = "CausalRuntimeRequestError";
  }
}

export class CausalCitationUngroundedError extends Error {
  constructor() {
    super("citation was not served");
    this.name = "CausalCitationUngroundedError";
  }
}

export type CausalMemoryRuntimeClient = {
  request<T>(path: string, operationId: string, token: string, body: unknown): Promise<T>;
};

export function createCausalRuntimeClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): CausalMemoryRuntimeClient {
  return {
    async request<T>(path: string, operationId: string, token: string, body: unknown) {
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            [CAUSAL_OPERATION_ID_HEADER]: operationId,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new CausalRuntimeRequestError("runtime_unavailable");
      }
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (isCausalRuntimeError(payload)) throw new CausalRuntimeRequestError(payload.error.code);
      if (!response.ok) throw new CausalRuntimeRequestError("runtime_unavailable");
      return payload as T;
    },
  };
}

export type CausalIngestInput = AdmittedSegmentIngestLedger & {
  session?: CausalSessionIdentity;
  turns?: CausalAuditTurn[];
};

export class CausalMemory implements CausalMemoryModule {
  constructor(
    private readonly repository: PrismaCausalMemoryRepository,
    private readonly runtime: CausalMemoryRuntimeClient,
    private readonly tenantToken: (workspaceId: string) => Promise<string>,
    private readonly workspaceId: string,
    private readonly offers?: CausalOfferPublisher,
  ) {}

  async ingestAdmittedSegment(input: CausalIngestInput): Promise<AdmittedSegmentIngestLedger> {
    if (input.workspaceId !== this.workspaceId) throw new CausalRuntimeRequestError("unauthorized");
    await this.repository.putPendingLedger(input);
    const token = await this.tenantToken(this.workspaceId);
    try {
      await this.repository.markLedgerState(input.workspaceId, input.operationId, "auditing");
      for (const turn of input.turns ?? []) {
        await this.runtime.request(
          CAUSAL_RUNTIME_ROUTES.auditTurns.path,
          `${input.operationId}-turn-${turn.messageId}`.slice(0, 128),
          token,
          {
            protocol: CAUSAL_RUNTIME_PROTOCOL,
            operationId: `${input.operationId}-turn-${turn.messageId}`.slice(0, 128),
            session: input.session ?? {
              workspaceId: this.workspaceId,
              channelId: this.workspaceId,
            },
            turn,
          },
        );
      }
      await this.repository.markLedgerState(input.workspaceId, input.operationId, "distilling");
      await this.runtime.request(
        CAUSAL_RUNTIME_ROUTES.distillSegment.path,
        input.operationId,
        token,
        {
          protocol: CAUSAL_RUNTIME_PROTOCOL,
          operationId: input.operationId,
          segment: {
            admittedSegmentId: input.admittedSegmentId,
            kind: input.kind,
            sourceMessageIds: input.sourceMessageIds,
            sourcePayloadHash: input.sourcePayloadHash,
          },
        },
      );
      return this.repository.markLedgerState(input.workspaceId, input.operationId, "succeeded");
    } catch (error) {
      if (error instanceof CausalReplayConflictError) throw error;
      return this.repository.markLedgerState(
        input.workspaceId,
        input.operationId,
        "temporary_failure",
        "runtime temporarily unavailable",
      );
    }
  }

  search(input: CausalSearchRequest): Promise<CausalReadResponse> {
    return this.read(CAUSAL_RUNTIME_ROUTES.search.path, input);
  }

  trace(input: CausalTraceRequest): Promise<CausalReadResponse> {
    return this.read(CAUSAL_RUNTIME_ROUTES.trace.path, input);
  }

  intervene(input: CausalInterveneRequest): Promise<CausalReadResponse> {
    return this.read(CAUSAL_RUNTIME_ROUTES.intervene.path, input);
  }

  async adjudicateCorrection(input: CausalAdjudicateRequest): Promise<CausalAdjudicateResponse> {
    return this.runtime.request(
      CAUSAL_RUNTIME_ROUTES.adjudicateCorrection.path,
      input.operationId,
      await this.tenantToken(this.workspaceId),
      input,
    );
  }

  async proposeCorrection(input: {
    operationId: string;
    causalItemId: string;
    contradictoryCitationRefs: string[];
    rationale: string;
  }): Promise<{ accepted: boolean; duplicate: boolean; proposalId: string }> {
    const citations = await this.requireCitations(input.contradictoryCitationRefs);
    const existing = await this.repository.putProposal({
      workspaceId: this.workspaceId,
      proposalId: input.operationId,
      operationId: input.operationId,
      causalItemId: input.causalItemId,
      contradictoryCitationIds: input.contradictoryCitationRefs,
      rationale: input.rationale,
    });
    const first = citations[0]!;
    const verdict = await this.adjudicateCorrection({
      protocol: CAUSAL_RUNTIME_PROTOCOL,
      operationId: input.operationId,
      proposal: {
        causalItemId: input.causalItemId,
        contradictoryEvidence: {
          admittedSegmentId: first.admittedSegmentId,
          sourceMessageIds: [
            ...new Set(citations.flatMap((citation) => citation.sourceMessageIds)),
          ],
          summary: input.rationale,
        },
      },
    });
    await this.repository.putSupersession({
      workspaceId: this.workspaceId,
      proposalId: existing.proposalId,
      verdict: verdict.verdict,
      superseded: verdict.superseded,
      auditId: verdict.auditId,
    });
    return {
      accepted: verdict.verdict === "accept",
      duplicate: false,
      proposalId: existing.proposalId,
    };
  }

  async publishOffer(input: {
    operationId: string;
    conversationId: string;
    targetAgentId: string;
    recipientRationale: string;
    citationRefs: string[];
    body: string;
    memoryAgentId: string;
  }): Promise<CausalOfferRecord & { citations: CausalCitationRecord[]; duplicate: boolean }> {
    const citations = await this.requireCitations(input.citationRefs);
    const replayed = await this.repository.getOffer(this.workspaceId, input.operationId);
    if (replayed) return { ...replayed, citations, duplicate: true };
    const active = await this.repository.isActiveChannelAgent(
      this.workspaceId,
      input.conversationId,
      input.targetAgentId,
    );
    if (!active) throw new CausalWorkspaceScopeError();
    if (!this.offers) throw new CausalRuntimeRequestError("runtime_unavailable");
    const delivered = await this.offers.publish({
      workspaceId: this.workspaceId,
      conversationId: input.conversationId,
      memoryAgentId: input.memoryAgentId,
      recipientAgentId: input.targetAgentId,
      body: input.body,
      requestId: input.operationId,
    });
    const offer = await this.repository.putOffer({
      workspaceId: this.workspaceId,
      operationId: input.operationId,
      conversationId: input.conversationId,
      recipientAgentId: input.targetAgentId,
      recipientRationale: input.recipientRationale,
      messageId: delivered.messageId,
      citationIds: input.citationRefs,
    });
    return { ...offer, citations, duplicate: false };
  }

  async bindCitations(
    operationId: string,
    items: CausalRuntimeCitation[],
  ): Promise<CausalCitationRecord[]> {
    return Promise.all(
      items.map((item) =>
        this.repository.putCitation({
          workspaceId: this.workspaceId,
          citationId: item.citationId,
          causalItemId: item.causalItemId,
          causalPathId: item.causalPathId,
          admittedSegmentId: item.admittedSegmentId,
          sourceMessageIds: item.sourceMessageIds,
          boundOperationId: operationId,
          displayContent: item.displayContent,
        }),
      ),
    );
  }

  private async requireCitations(citationRefs: string[]): Promise<CausalCitationRecord[]> {
    const citations = await Promise.all(
      citationRefs.map((citationId) => this.repository.getCitation(this.workspaceId, citationId)),
    );
    if (citations.some((citation) => !citation)) throw new CausalCitationUngroundedError();
    return citations as CausalCitationRecord[];
  }

  private async read(
    path: string,
    input: CausalSearchRequest | CausalTraceRequest | CausalInterveneRequest,
  ): Promise<CausalReadResponse> {
    const response = await this.runtime.request<CausalReadResponse>(
      path,
      input.operationId,
      await this.tenantToken(this.workspaceId),
      input,
    );
    if (!Array.isArray(response.items)) throw new CausalRuntimeRequestError("invalid_request");
    await this.bindCitations(input.operationId, response.items);
    return response;
  }
}
