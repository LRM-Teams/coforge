/**
 * Private Causal Memory extension + Web module contract (W0 freeze).
 *
 * Framework-free JSON between Web/backend and the pinned Causal Memory runtime.
 * Only Web/backend holds tenant tokens. `/debug/*`, `/mcp`, and a default store
 * are never the Coforge evidence path.
 *
 * Test seams that consume this file: extension HTTP contract; Web CausalMemory
 * module. Public-channel scenario tests import these names; no UI tests do.
 */

/** Must stay identical to `packages/coforge-sdk/src/agent/causal-memory.ts`. */
export const CAUSAL_AGENT_PROTOCOL = "coforge.causal.agent.v1" as const;
export const CAUSAL_OPERATION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";

export type CausalCitation = {
  citationId: string;
  causalItemId: string;
  causalPathId?: string;
  admittedSegmentId: string;
  sourceMessageIds: string[];
  displayContent: string;
};

export const CAUSAL_RUNTIME_PROTOCOL = "coforge.causal.runtime.v1" as const;
export const CAUSAL_RUNTIME_BASE_PATH = "/coforge/v1" as const;
export const CAUSAL_OPERATION_ID_HEADER = "X-Coforge-Operation-Id" as const;

export const CAUSAL_RUNTIME_ROUTES = {
  healthz: { method: "GET", path: "/healthz" },
  readyz: { method: "GET", path: "/readyz" },
  auditTurns: { method: "POST", path: `${CAUSAL_RUNTIME_BASE_PATH}/audit/turns` },
  distillSegment: { method: "POST", path: `${CAUSAL_RUNTIME_BASE_PATH}/segments/distill` },
  search: { method: "POST", path: `${CAUSAL_RUNTIME_BASE_PATH}/search` },
  trace: { method: "POST", path: `${CAUSAL_RUNTIME_BASE_PATH}/trace` },
  intervene: { method: "POST", path: `${CAUSAL_RUNTIME_BASE_PATH}/intervene` },
  adjudicateCorrection: {
    method: "POST",
    path: `${CAUSAL_RUNTIME_BASE_PATH}/corrections/adjudicate`,
  },
} as const;

export const CAUSAL_PROHIBITED_EVIDENCE_PATHS = ["/debug/", "/mcp", "/"] as const;

export const CAUSAL_RUNTIME_ERROR_CODES = [
  "unauthorized",
  "tenant_not_found",
  "replay_conflict",
  "invalid_request",
  "raw_not_searchable",
  "citation_ungrounded",
  "runtime_unavailable",
  "distill_failed_temporary",
  "correction_rejected",
] as const;
export type CausalRuntimeErrorCode = (typeof CAUSAL_RUNTIME_ERROR_CODES)[number];

export const INGEST_LEDGER_STATES = [
  "pending",
  "auditing",
  "distilling",
  "succeeded",
  "temporary_failure",
] as const;
export type IngestLedgerState = (typeof INGEST_LEDGER_STATES)[number];

export const ADMITTED_SEGMENT_KINDS = ["completed_task", "quiet_window"] as const;
export type AdmittedSegmentKind = (typeof ADMITTED_SEGMENT_KINDS)[number];

export const CAUSAL_ITEM_KINDS = ["fact", "causal_edge", "intervention"] as const;
export type CausalItemKind = (typeof CAUSAL_ITEM_KINDS)[number];

export const CORRECTION_VERDICTS = ["accept", "reject"] as const;
export type CorrectionVerdict = (typeof CORRECTION_VERDICTS)[number];

export type CausalRuntimeError = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId?: string;
  error: {
    code: CausalRuntimeErrorCode;
    message: string;
  };
};

export type CausalTenantAuth = {
  scheme: "Bearer";
  tenantToken: string;
};

export type CausalSessionIdentity = {
  workspaceId: string;
  channelId: string;
  threadId?: string;
};

export type CausalAuditTurn = {
  messageId: string;
  sequence: number;
  occurredAt: string;
  payloadHash: string;
  senderKind: "human" | "agent" | "system";
  senderHandle: string;
  body: string;
};

export type CausalAuditTurnRequest = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  session: CausalSessionIdentity;
  turn: CausalAuditTurn;
};

export type CausalAuditTurnResponse = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  outcome: "accepted" | "replayed";
  turnId: string;
  searchable: false;
};

export type CausalDistillRequest = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  segment: {
    admittedSegmentId: string;
    kind: AdmittedSegmentKind;
    sourceMessageIds: string[];
    sourcePayloadHash: string;
  };
};

export type CausalRuntimeCitation = CausalCitation & {
  itemKind: CausalItemKind;
};

export type CausalDistillResponse = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  outcome: "distilled" | "replayed";
  items: CausalRuntimeCitation[];
};

export type CausalSearchRequest = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  query: string;
  limit?: number;
};

export type CausalTraceRequest = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  causalItemId: string;
};

export type CausalInterveneRequest = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  action: string;
  context?: string;
};

export type CausalReadResponse = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  duplicate: boolean;
  items: CausalRuntimeCitation[];
};

export type CausalAdjudicateRequest = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  proposal: {
    causalItemId: string;
    contradictoryEvidence: {
      admittedSegmentId: string;
      sourceMessageIds: string[];
      summary: string;
    };
  };
};

export type CausalAdjudicateResponse = {
  protocol: typeof CAUSAL_RUNTIME_PROTOCOL;
  operationId: string;
  verdict: CorrectionVerdict;
  superseded: boolean;
  auditId: string;
};

export type CausalWorkspaceTenant = {
  workspaceId: string;
  tenantId: string;
  enabled: boolean;
  memoryAgentId?: string;
};

export type AdmittedSegmentIngestLedger = {
  workspaceId: string;
  admittedSegmentId: string;
  operationId: string;
  kind: AdmittedSegmentKind;
  sourceMessageIds: string[];
  sourcePayloadHash: string;
  state: IngestLedgerState;
  attemptCount: number;
  sanitizedError?: string;
};

export type SegmentSourceMessage = {
  admittedSegmentId: string;
  messageId: string;
  payloadHash: string;
};

export type CausalCitationRecord = {
  workspaceId: string;
  citationId: string;
  causalItemId: string;
  causalPathId?: string;
  admittedSegmentId: string;
  sourceMessageIds: string[];
  boundOperationId: string;
  displayContent?: string;
};

export type CausalOfferRecord = {
  workspaceId: string;
  operationId: string;
  conversationId: string;
  recipientAgentId: string;
  recipientRationale: string;
  messageId: string;
  citationIds: string[];
};

export type CausalCorrectionProposalRecord = {
  workspaceId: string;
  proposalId: string;
  operationId: string;
  causalItemId: string;
  contradictoryCitationIds: string[];
  rationale: string;
};

export type CausalSupersessionResult = {
  workspaceId: string;
  proposalId: string;
  verdict: CorrectionVerdict;
  superseded: boolean;
  auditId: string;
};

/** Intent-level Web module surface implemented in W2. Returns typed evidence only. */
export type CausalMemoryModule = {
  ingestAdmittedSegment(input: AdmittedSegmentIngestLedger): Promise<AdmittedSegmentIngestLedger>;
  search(input: CausalSearchRequest): Promise<CausalReadResponse>;
  trace(input: CausalTraceRequest): Promise<CausalReadResponse>;
  intervene(input: CausalInterveneRequest): Promise<CausalReadResponse>;
  adjudicateCorrection(input: CausalAdjudicateRequest): Promise<CausalAdjudicateResponse>;
};

export function isCausalRuntimeErrorCode(value: unknown): value is CausalRuntimeErrorCode {
  return (
    typeof value === "string" && (CAUSAL_RUNTIME_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isCausalRuntimeError(value: unknown): value is CausalRuntimeError {
  if (!value || typeof value !== "object") return false;
  const error = value as CausalRuntimeError;
  return (
    error.protocol === CAUSAL_RUNTIME_PROTOCOL &&
    (error.operationId === undefined ||
      (typeof error.operationId === "string" &&
        new RegExp(CAUSAL_OPERATION_ID_PATTERN).test(error.operationId))) &&
    !!error.error &&
    isCausalRuntimeErrorCode(error.error.code) &&
    typeof error.error.message === "string"
  );
}

export function isProhibitedEvidencePath(path: string): boolean {
  if (path === "/" || path === "/mcp") return true;
  return path.startsWith("/debug/");
}

export function decodeCausalAuditTurnRequest(value: unknown): CausalAuditTurnRequest {
  if (!value || typeof value !== "object") throw new Error("invalid audit turn request");
  const request = value as CausalAuditTurnRequest;
  if (request.protocol !== CAUSAL_RUNTIME_PROTOCOL) throw new Error("invalid causal protocol");
  if (!new RegExp(CAUSAL_OPERATION_ID_PATTERN).test(request.operationId))
    throw new Error("invalid operationId");
  if (
    !request.session ||
    typeof request.session.workspaceId !== "string" ||
    typeof request.session.channelId !== "string"
  )
    throw new Error("invalid session identity");
  const turn = request.turn;
  if (
    !turn ||
    typeof turn.messageId !== "string" ||
    !Number.isInteger(turn.sequence) ||
    typeof turn.occurredAt !== "string" ||
    typeof turn.payloadHash !== "string" ||
    (turn.senderKind !== "human" && turn.senderKind !== "agent" && turn.senderKind !== "system") ||
    typeof turn.senderHandle !== "string" ||
    typeof turn.body !== "string"
  )
    throw new Error("invalid audit turn");
  return request;
}

export function decodeCausalDistillRequest(value: unknown): CausalDistillRequest {
  if (!value || typeof value !== "object") throw new Error("invalid distill request");
  const request = value as CausalDistillRequest;
  if (request.protocol !== CAUSAL_RUNTIME_PROTOCOL) throw new Error("invalid causal protocol");
  if (!new RegExp(CAUSAL_OPERATION_ID_PATTERN).test(request.operationId))
    throw new Error("invalid operationId");
  const segment = request.segment;
  if (
    !segment ||
    typeof segment.admittedSegmentId !== "string" ||
    !(ADMITTED_SEGMENT_KINDS as readonly string[]).includes(segment.kind) ||
    !Array.isArray(segment.sourceMessageIds) ||
    segment.sourceMessageIds.length === 0 ||
    typeof segment.sourcePayloadHash !== "string"
  )
    throw new Error("invalid admitted segment");
  return request;
}
