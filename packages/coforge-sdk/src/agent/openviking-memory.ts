/**
 * Agent-facing OpenViking read-only command/response contract (C2 freeze).
 *
 * Framework-free JSON that travels Agent → local Daemon proxy → Web gateway.
 * Tenant credentials never appear here. The Memory Agent may find, expand
 * hierarchical context, read, or offer; it cannot write files, commit sessions,
 * or mutate skills or ACLs.
 */

import { isCausalOperationId } from "./causal-memory";
import { decodeOpenVikingCitation, type OpenVikingCitation } from "./memory-citations";

export const OPENVIKING_AGENT_PROTOCOL = "coforge.openviking.agent.v1" as const;

/** Fenced runtime tool-profile kind. Distinct from Workspace Memory Profile persistence. */
export const OPENVIKING_TOOL_PROFILE = "openviking-memory" as const;

export const MEMORY_READ_BUDGET_PER_TRIGGER = 3 as const;
export const MEMORY_OFFER_BUDGET_PER_TRIGGER = 1 as const;
export const OPENVIKING_CANDIDATE_LIMIT_MAX = 10 as const;

export const OPENVIKING_AGENT_OPERATIONS = ["find", "search_context", "read", "offer"] as const;
export type OpenVikingAgentOperation = (typeof OPENVIKING_AGENT_OPERATIONS)[number];

export const OPENVIKING_AGENT_READ_OPERATIONS = ["find", "search_context", "read"] as const;
export type OpenVikingAgentReadOperation = (typeof OPENVIKING_AGENT_READ_OPERATIONS)[number];

/** Native tool names on the fenced OpenViking Memory Agent profile (plus channel message I/O). */
export const OPENVIKING_TOOL_NAMES = {
  find: "ov_find",
  searchContext: "ov_search_context",
  read: "ov_read",
  offer: "memory_offer",
} as const;

export const OPENVIKING_AGENT_ERROR_CODES = [
  "openviking-request-invalid",
  "openviking-unauthorized",
  "openviking-citation-ungrounded",
  "openviking-budget-exhausted",
  "openviking-runtime-unavailable",
  "openviking-duplicate-conflict",
] as const;
export type OpenVikingAgentErrorCode = (typeof OPENVIKING_AGENT_ERROR_CODES)[number];

export type OpenVikingFindCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "find";
  operationId: string;
  query: string;
  limit?: number;
  targetUri?: string;
};

export type OpenVikingSearchContextCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "search_context";
  operationId: string;
  query: string;
  limit?: number;
  targetUri?: string;
  tokenBudget?: number;
};

export type OpenVikingReadCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "read";
  operationId: string;
  uri: string;
};

export type OpenVikingOfferCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "offer";
  operationId: string;
  conversationId: string;
  targetAgentId: string;
  recipientRationale: string;
  citationRefs: string[];
  body: string;
};

export type OpenVikingAgentCommand =
  | OpenVikingFindCommand
  | OpenVikingSearchContextCommand
  | OpenVikingReadCommand
  | OpenVikingOfferCommand;

export type OpenVikingFindResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "find";
  operationId: string;
  duplicate: boolean;
  items: OpenVikingCitation[];
};

export type OpenVikingSearchContextResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "search_context";
  operationId: string;
  duplicate: boolean;
  items: OpenVikingCitation[];
};

export type OpenVikingReadResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "read";
  operationId: string;
  duplicate: boolean;
  citation: OpenVikingCitation;
  content: string;
};

export type OpenVikingOfferResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "offer";
  operationId: string;
  published: boolean;
  duplicate: boolean;
  messageId?: string;
  recipientAgentId?: string;
  citations: OpenVikingCitation[];
};

export type OpenVikingAgentError = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  operationId?: string;
  error: {
    code: OpenVikingAgentErrorCode;
    message: string;
  };
};

export type OpenVikingAgentResponse =
  | OpenVikingFindResponse
  | OpenVikingSearchContextResponse
  | OpenVikingReadResponse
  | OpenVikingOfferResponse;

export const isOpenVikingOperationId = isCausalOperationId;

export function isOpenVikingAgentOperation(value: unknown): value is OpenVikingAgentOperation {
  return (
    typeof value === "string" && (OPENVIKING_AGENT_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isOpenVikingAgentReadOperation(
  value: unknown,
): value is OpenVikingAgentReadOperation {
  return (
    typeof value === "string" &&
    (OPENVIKING_AGENT_READ_OPERATIONS as readonly string[]).includes(value)
  );
}

function optionalCandidateLimit(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > OPENVIKING_CANDIDATE_LIMIT_MAX
  )
    throw new Error(`invalid ${label} limit`);
  return value as number;
}

function optionalTargetUri(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`invalid ${label} targetUri`);
  return value;
}

function optionalTokenBudget(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new Error(`invalid ${label} tokenBudget`);
  return value as number;
}

export function decodeOpenVikingAgentCommand(value: unknown): OpenVikingAgentCommand {
  if (!value || typeof value !== "object") throw new Error("invalid openviking command");
  const command = value as Partial<OpenVikingAgentCommand> & { query?: unknown; uri?: unknown };
  if (command.protocol !== OPENVIKING_AGENT_PROTOCOL)
    throw new Error("invalid openviking protocol");
  if (!isOpenVikingAgentOperation(command.op)) throw new Error("invalid openviking operation");
  if (!isOpenVikingOperationId(command.operationId))
    throw new Error("invalid openviking operationId");
  const operationId = command.operationId;

  if (command.op === "find") {
    if (typeof command.query !== "string" || command.query.trim() === "")
      throw new Error("invalid openviking find query");
    const limit = optionalCandidateLimit(command.limit, "openviking find");
    const targetUri = optionalTargetUri(command.targetUri, "openviking find");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId,
      query: command.query,
      ...(limit === undefined ? {} : { limit }),
      ...(targetUri === undefined ? {} : { targetUri }),
    };
  }

  if (command.op === "search_context") {
    if (typeof command.query !== "string" || command.query.trim() === "")
      throw new Error("invalid openviking search_context query");
    const limit = optionalCandidateLimit(command.limit, "openviking search_context");
    const targetUri = optionalTargetUri(command.targetUri, "openviking search_context");
    const tokenBudget = optionalTokenBudget(
      (command as Partial<OpenVikingSearchContextCommand>).tokenBudget,
      "openviking search_context",
    );
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId,
      query: command.query,
      ...(limit === undefined ? {} : { limit }),
      ...(targetUri === undefined ? {} : { targetUri }),
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    };
  }

  if (command.op === "read") {
    if (typeof command.uri !== "string" || command.uri.length === 0)
      throw new Error("invalid openviking read uri");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "read",
      operationId,
      uri: command.uri,
    };
  }

  const offer = command as Partial<OpenVikingOfferCommand>;
  if (
    offer.op !== "offer" ||
    typeof offer.conversationId !== "string" ||
    offer.conversationId.length === 0 ||
    typeof offer.targetAgentId !== "string" ||
    offer.targetAgentId.length === 0 ||
    typeof offer.recipientRationale !== "string" ||
    offer.recipientRationale.trim() === "" ||
    !Array.isArray(offer.citationRefs) ||
    offer.citationRefs.length === 0 ||
    !offer.citationRefs.every((id) => typeof id === "string" && id.length > 0) ||
    typeof offer.body !== "string" ||
    offer.body.trim() === ""
  )
    throw new Error("invalid openviking offer");
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId,
    conversationId: offer.conversationId,
    targetAgentId: offer.targetAgentId,
    recipientRationale: offer.recipientRationale,
    citationRefs: offer.citationRefs,
    body: offer.body,
  };
}

function decodeOpenVikingCitationList(value: unknown, label: string): OpenVikingCitation[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label} citations`);
  if (value.length > OPENVIKING_CANDIDATE_LIMIT_MAX)
    throw new Error("openviking candidate limit exceeded");
  return value.map(decodeOpenVikingCitation);
}

export function decodeOpenVikingAgentResponse(
  op: OpenVikingAgentOperation,
  value: unknown,
): OpenVikingAgentResponse {
  if (!value || typeof value !== "object") throw new Error("invalid openviking response");
  const response = value as OpenVikingAgentResponse;
  if (response.protocol !== OPENVIKING_AGENT_PROTOCOL)
    throw new Error("invalid openviking protocol");
  if (response.op !== op) throw new Error("openviking response op mismatch");
  if (!isOpenVikingOperationId(response.operationId))
    throw new Error("invalid openviking operationId");
  if (typeof response.duplicate !== "boolean") throw new Error("invalid openviking duplicate flag");

  if (response.op === "find") {
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: response.operationId,
      duplicate: response.duplicate,
      items: decodeOpenVikingCitationList(response.items, "openviking find"),
    };
  }

  if (response.op === "search_context") {
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId: response.operationId,
      duplicate: response.duplicate,
      items: decodeOpenVikingCitationList(response.items, "openviking search_context"),
    };
  }

  if (response.op === "read") {
    const read = response as OpenVikingReadResponse;
    if (typeof read.content !== "string") throw new Error("invalid openviking read content");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "read",
      operationId: read.operationId,
      duplicate: read.duplicate,
      citation: decodeOpenVikingCitation(read.citation),
      content: read.content,
    };
  }

  const offer = response as OpenVikingOfferResponse;
  if (typeof offer.published !== "boolean") throw new Error("invalid openviking offer published");
  if (offer.messageId !== undefined && typeof offer.messageId !== "string")
    throw new Error("invalid openviking offer messageId");
  if (offer.recipientAgentId !== undefined && typeof offer.recipientAgentId !== "string")
    throw new Error("invalid openviking offer recipient");
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: offer.operationId,
    published: offer.published,
    duplicate: offer.duplicate,
    ...(offer.messageId === undefined ? {} : { messageId: offer.messageId }),
    ...(offer.recipientAgentId === undefined ? {} : { recipientAgentId: offer.recipientAgentId }),
    citations: decodeOpenVikingCitationList(offer.citations, "openviking offer"),
  };
}

export function isOpenVikingAgentError(value: unknown): value is OpenVikingAgentError {
  if (!value || typeof value !== "object") return false;
  const error = value as OpenVikingAgentError;
  return (
    error.protocol === OPENVIKING_AGENT_PROTOCOL &&
    (error.operationId === undefined || isOpenVikingOperationId(error.operationId)) &&
    !!error.error &&
    (OPENVIKING_AGENT_ERROR_CODES as readonly string[]).includes(error.error.code) &&
    typeof error.error.message === "string"
  );
}
