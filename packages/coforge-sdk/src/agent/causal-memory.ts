/**
 * Agent-facing Causal Memory command/response contract (W0 freeze).
 *
 * Framework-free JSON that travels Agent → local Daemon proxy → Web/backend.
 * Tenant tokens never appear here. The Memory Agent may search, trace, intervene,
 * offer, or propose a correction; it cannot invalidate or supersede causal data.
 *
 * Test seams that consume this file: Agent local proxy contract; public-channel
 * scenario. No UI tests are defined against these types.
 */

export const CAUSAL_AGENT_PROTOCOL = "coforge.causal.agent.v1" as const;

/** Fenced runtime tool-profile kind. Absent on AgentStartIntent = ordinary full-tool runtime. */
export const CAUSAL_TOOL_PROFILE = "causal-memory" as const;

/** Client-invented idempotency handle. Same pattern the server rejects with 400. */
export const CAUSAL_OPERATION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";

export const CAUSAL_READ_BUDGET_PER_TRIGGER = 3 as const;
export const CAUSAL_OFFER_BUDGET_PER_TRIGGER = 1 as const;

export const CAUSAL_AGENT_OPERATIONS = [
  "search",
  "trace",
  "intervene",
  "offer",
  "propose_correction",
] as const;
export type CausalAgentOperation = (typeof CAUSAL_AGENT_OPERATIONS)[number];

export const CAUSAL_AGENT_READ_OPERATIONS = ["search", "trace", "intervene"] as const;
export type CausalAgentReadOperation = (typeof CAUSAL_AGENT_READ_OPERATIONS)[number];

/** Native tool names on the fenced Memory Agent profile (plus channel message I/O). */
export const CAUSAL_TOOL_NAMES = {
  search: "causal_search",
  trace: "causal_trace",
  intervene: "causal_intervention",
  offer: "memory_offer",
  proposeCorrection: "causal_propose_correction",
} as const;

export const CAUSAL_AGENT_ERROR_CODES = [
  "causal-request-invalid",
  "causal-unauthorized",
  "causal-citation-ungrounded",
  "causal-budget-exhausted",
  "causal-runtime-unavailable",
  "causal-duplicate-conflict",
] as const;
export type CausalAgentErrorCode = (typeof CAUSAL_AGENT_ERROR_CODES)[number];

export type CausalCitation = {
  citationId: string;
  causalItemId: string;
  causalPathId?: string;
  admittedSegmentId: string;
  sourceMessageIds: string[];
  displayContent: string;
};

export type CausalSearchCommand = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: "search";
  operationId: string;
  query: string;
  limit?: number;
};

export type CausalTraceCommand = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: "trace";
  operationId: string;
  causalItemId: string;
};

export type CausalInterveneCommand = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: "intervene";
  operationId: string;
  action: string;
  context?: string;
};

export type CausalOfferCommand = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: "offer";
  operationId: string;
  conversationId: string;
  targetAgentId: string;
  recipientRationale: string;
  citationRefs: string[];
  body: string;
};

export type CausalProposeCorrectionCommand = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: "propose_correction";
  operationId: string;
  causalItemId: string;
  contradictoryCitationRefs: string[];
  rationale: string;
};

export type CausalAgentCommand =
  | CausalSearchCommand
  | CausalTraceCommand
  | CausalInterveneCommand
  | CausalOfferCommand
  | CausalProposeCorrectionCommand;

export type CausalReadResponse = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: CausalAgentReadOperation;
  operationId: string;
  duplicate: boolean;
  items: CausalCitation[];
};

export type CausalOfferResponse = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: "offer";
  operationId: string;
  published: boolean;
  duplicate: boolean;
  messageId?: string;
  recipientAgentId?: string;
  citations: CausalCitation[];
};

export type CausalProposeCorrectionResponse = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  op: "propose_correction";
  operationId: string;
  accepted: boolean;
  duplicate: boolean;
  proposalId: string;
};

export type CausalAgentError = {
  protocol: typeof CAUSAL_AGENT_PROTOCOL;
  operationId?: string;
  error: {
    code: CausalAgentErrorCode;
    message: string;
  };
};

export type CausalAgentResponse =
  | CausalReadResponse
  | CausalOfferResponse
  | CausalProposeCorrectionResponse;

export type CausalBudgetDiagnostic = {
  triggerMessageId: string;
  causalReadsUsed: number;
  offersPublished: number;
  stoppedReason?: "read_budget" | "offer_budget";
};

export function isCausalOperationId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(CAUSAL_OPERATION_ID_PATTERN).test(value);
}

export function isCausalAgentOperation(value: unknown): value is CausalAgentOperation {
  return (
    typeof value === "string" && (CAUSAL_AGENT_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isCausalAgentReadOperation(value: unknown): value is CausalAgentReadOperation {
  return (
    typeof value === "string" && (CAUSAL_AGENT_READ_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isCausalCitation(value: unknown): value is CausalCitation {
  if (!value || typeof value !== "object") return false;
  const citation = value as CausalCitation;
  return (
    typeof citation.citationId === "string" &&
    citation.citationId.length > 0 &&
    typeof citation.causalItemId === "string" &&
    citation.causalItemId.length > 0 &&
    (citation.causalPathId === undefined || typeof citation.causalPathId === "string") &&
    typeof citation.admittedSegmentId === "string" &&
    citation.admittedSegmentId.length > 0 &&
    Array.isArray(citation.sourceMessageIds) &&
    citation.sourceMessageIds.every((id) => typeof id === "string" && id.length > 0) &&
    typeof citation.displayContent === "string"
  );
}

export function decodeCausalAgentCommand(value: unknown): CausalAgentCommand {
  if (!value || typeof value !== "object") throw new Error("invalid causal command");
  const command = value as Partial<CausalAgentCommand>;
  if (command.protocol !== CAUSAL_AGENT_PROTOCOL) throw new Error("invalid causal protocol");
  if (!isCausalAgentOperation(command.op)) throw new Error("invalid causal operation");
  if (!isCausalOperationId(command.operationId)) throw new Error("invalid causal operationId");
  const operationId = command.operationId;

  if (command.op === "search") {
    if (typeof command.query !== "string" || command.query.trim() === "")
      throw new Error("invalid causal search query");
    if (command.limit !== undefined && (!Number.isInteger(command.limit) || command.limit < 1))
      throw new Error("invalid causal search limit");
    return {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId,
      query: command.query,
      ...(command.limit === undefined ? {} : { limit: command.limit }),
    };
  }

  if (command.op === "trace") {
    if (typeof command.causalItemId !== "string" || command.causalItemId.length === 0)
      throw new Error("invalid causal trace item");
    return {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "trace",
      operationId,
      causalItemId: command.causalItemId,
    };
  }

  if (command.op === "intervene") {
    if (typeof command.action !== "string" || command.action.trim() === "")
      throw new Error("invalid causal intervene action");
    if (command.context !== undefined && typeof command.context !== "string")
      throw new Error("invalid causal intervene context");
    return {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "intervene",
      operationId,
      action: command.action,
      ...(command.context === undefined ? {} : { context: command.context }),
    };
  }

  if (command.op === "offer") {
    if (typeof command.conversationId !== "string" || command.conversationId.length === 0)
      throw new Error("invalid causal offer conversation");
    if (typeof command.targetAgentId !== "string" || command.targetAgentId.length === 0)
      throw new Error("invalid causal offer recipient");
    if (typeof command.recipientRationale !== "string" || command.recipientRationale.trim() === "")
      throw new Error("invalid causal offer rationale");
    if (
      !Array.isArray(command.citationRefs) ||
      command.citationRefs.length === 0 ||
      !command.citationRefs.every((id) => typeof id === "string" && id.length > 0)
    )
      throw new Error("invalid causal offer citations");
    if (typeof command.body !== "string" || command.body.trim() === "")
      throw new Error("invalid causal offer body");
    return {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "offer",
      operationId,
      conversationId: command.conversationId,
      targetAgentId: command.targetAgentId,
      recipientRationale: command.recipientRationale,
      citationRefs: command.citationRefs,
      body: command.body,
    };
  }

  const proposal = command as Partial<CausalProposeCorrectionCommand>;
  if (
    proposal.op !== "propose_correction" ||
    typeof proposal.causalItemId !== "string" ||
    proposal.causalItemId.length === 0 ||
    !Array.isArray(proposal.contradictoryCitationRefs) ||
    proposal.contradictoryCitationRefs.length === 0 ||
    !proposal.contradictoryCitationRefs.every((id) => typeof id === "string" && id.length > 0) ||
    typeof proposal.rationale !== "string" ||
    proposal.rationale.trim() === ""
  )
    throw new Error("invalid causal correction proposal");
  return {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "propose_correction",
    operationId,
    causalItemId: proposal.causalItemId,
    contradictoryCitationRefs: proposal.contradictoryCitationRefs,
    rationale: proposal.rationale,
  };
}

export function decodeCausalAgentResponse(
  op: CausalAgentOperation,
  value: unknown,
): CausalAgentResponse {
  if (!value || typeof value !== "object") throw new Error("invalid causal response");
  const response = value as CausalAgentResponse;
  if (response.protocol !== CAUSAL_AGENT_PROTOCOL) throw new Error("invalid causal protocol");
  if (response.op !== op) throw new Error("causal response op mismatch");
  if (!isCausalOperationId(response.operationId)) throw new Error("invalid causal operationId");
  if (typeof response.duplicate !== "boolean") throw new Error("invalid causal duplicate flag");

  if (isCausalAgentReadOperation(response.op)) {
    const read = response as CausalReadResponse;
    if (!Array.isArray(read.items) || !read.items.every(isCausalCitation))
      throw new Error("invalid causal citations");
    return read;
  }

  if (response.op === "offer") {
    const offer = response as CausalOfferResponse;
    if (typeof offer.published !== "boolean") throw new Error("invalid causal offer published");
    if (offer.messageId !== undefined && typeof offer.messageId !== "string")
      throw new Error("invalid causal offer messageId");
    if (offer.recipientAgentId !== undefined && typeof offer.recipientAgentId !== "string")
      throw new Error("invalid causal offer recipient");
    if (!Array.isArray(offer.citations) || !offer.citations.every(isCausalCitation))
      throw new Error("invalid causal offer citations");
    return offer;
  }

  const proposal = response as CausalProposeCorrectionResponse;
  if (typeof proposal.accepted !== "boolean") throw new Error("invalid correction accepted");
  if (typeof proposal.proposalId !== "string" || proposal.proposalId.length === 0)
    throw new Error("invalid correction proposalId");
  return proposal;
}

export function isCausalAgentError(value: unknown): value is CausalAgentError {
  if (!value || typeof value !== "object") return false;
  const error = value as CausalAgentError;
  return (
    error.protocol === CAUSAL_AGENT_PROTOCOL &&
    (error.operationId === undefined || isCausalOperationId(error.operationId)) &&
    !!error.error &&
    (CAUSAL_AGENT_ERROR_CODES as readonly string[]).includes(error.error.code) &&
    typeof error.error.message === "string"
  );
}
