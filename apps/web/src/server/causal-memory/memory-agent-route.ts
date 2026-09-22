/**
 * F4 Memory Agent command composition for the Agent HTTPS routes.
 * Legacy unversioned CausalCitation remains on the pre-F4 causal slice only.
 */

import {
  CAUSAL_AGENT_PROTOCOL,
  CAUSAL_MEMORY_CITATION_KIND,
  CAUSAL_OPENVIKING_TOOL_PROFILE,
  CAUSAL_TOOL_PROFILE,
  decodeCausalAgentCommand,
  decodeOpenVikingAgentCommand,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_CITATION_KIND,
  OPENVIKING_TOOL_PROFILE,
  type CausalAgentCommand,
  type CausalAgentResponse,
  type CausalMemoryCitation,
  type CausalCitation,
  type MemoryAgentToolProfile,
  type MemoryCitation,
  type OpenVikingAgentCommand,
  type OpenVikingAgentResponse,
  type OpenVikingCitation,
} from "@lrm/coforge-sdk/agent";
import { CausalWorkspaceScopeError } from "../db/repositories/causal-memory.repositories.server";
import { CAUSAL_RUNTIME_PROTOCOL, CAUSAL_RUNTIME_ROUTES } from "./contract";
import {
  MemoryCitationCorrectionError,
  MemoryCitationUngroundedError,
  type MemoryCitationBindings,
} from "./memory-citations";
import { MemoryAgentBudgetError, type MemoryAgentBudgetLedger } from "./memory-agent-budget";
import type { MemoryOffers } from "./memory-offers";
import { MemoryAgentMutationError, type OpenVikingMemoryReads } from "./openviking-memory-reads";
import {
  DEFAULT_OFFER_RATIONALE,
  MemoryOfferTargetError,
} from "./explicit-memory-answer";

export const MEMORY_AGENT_TRIGGER_HEADER = "x-coforge-trigger-message-id";

export class MemoryAgentUnauthorizedError extends Error {
  constructor() {
    super("not the workspace Memory Agent");
    this.name = "MemoryAgentUnauthorizedError";
  }
}

export type MemoryAgentDirectory = {
  isDesignated(workspaceId: string, agentId: string): Promise<boolean>;
};

export type MemoryAgentFenceLookup = {
  resolve(workspaceId: string): Promise<MemoryAgentToolProfile | undefined>;
};

export type CausalRuntimeRead = {
  request<T>(path: string, operationId: string, token: string, body: unknown): Promise<T>;
};

export type MixedOfferCitationFields = {
  openvikingCitations?: OpenVikingCitation[];
  causalCitations?: Array<CausalCitation & MemoryCitation>;
};

export type MemoryAgentCommandResult =
  | {
      ok: true;
      response: (CausalAgentResponse | OpenVikingAgentResponse) & MixedOfferCitationFields;
    }
  | {
      ok: false;
      status: number;
      protocol: string;
      operationId?: string;
      code: string;
      message: string;
    };

export type MemoryOfferTargetResolver = {
  resolve(
    workspaceId: string,
    memoryAgentId: string,
  ): Promise<{ conversationId: string; targetAgentId: string } | null>;
};

export type MemoryAgentCommands = {
  handle(input: {
    workspaceId: string;
    agentId: string;
    triggerMessageId: string;
    command: unknown;
  }): Promise<MemoryAgentCommandResult>;
};

export function createMemoryAgentCommands(deps: {
  fence: MemoryAgentFenceLookup;
  directory: MemoryAgentDirectory;
  budgets: MemoryAgentBudgetLedger;
  citations: MemoryCitationBindings;
  offers: MemoryOffers;
  openviking: OpenVikingMemoryReads;
  causalRuntime: CausalRuntimeRead;
  tenantToken: (workspaceId: string) => Promise<string>;
  offerTargets?: MemoryOfferTargetResolver;
}): MemoryAgentCommands {
  return {
    async handle(input) {
      if (!(await deps.directory.isDesignated(input.workspaceId, input.agentId))) {
        return failure(
          403,
          peekProtocol(input.command),
          peekOperationId(input.command),
          "unauthorized",
        );
      }
      const fence = await deps.fence.resolve(input.workspaceId);
      let command: CausalAgentCommand | OpenVikingAgentCommand;
      try {
        command = decodeCommand(input.command);
      } catch {
        return failure(400, peekProtocol(input.command), peekOperationId(input.command), "invalid");
      }
      if (!fenceAllows(fence, command)) {
        return failure(403, command.protocol, command.operationId, "unauthorized");
      }
      try {
        deps.budgets
          .forTrigger({
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            triggerMessageId: input.triggerMessageId,
          })
          .consume(command, fence);
        if (command.protocol === OPENVIKING_AGENT_PROTOCOL)
          return { ok: true, response: await handleOpenViking(deps, input, command) };
        return { ok: true, response: await handleCausal(deps, input, command) };
      } catch (error) {
        return translateError(command, error);
      }
    },
  };
}

async function offerDelivery(
  deps: { offerTargets?: MemoryOfferTargetResolver },
  input: { workspaceId: string; agentId: string },
  command: {
    conversationId?: string;
    targetAgentId?: string;
    recipientRationale?: string;
  },
): Promise<{ conversationId: string; targetAgentId: string; recipientRationale: string }> {
  const rationale = command.recipientRationale?.trim();
  if (command.conversationId && command.targetAgentId) {
    return {
      conversationId: command.conversationId,
      targetAgentId: command.targetAgentId,
      recipientRationale: rationale || DEFAULT_OFFER_RATIONALE,
    };
  }
  const resolved = (await deps.offerTargets?.resolve(input.workspaceId, input.agentId)) ?? null;
  if (!resolved) throw new MemoryOfferTargetError();
  return {
    conversationId: resolved.conversationId,
    targetAgentId: resolved.targetAgentId,
    recipientRationale: rationale || DEFAULT_OFFER_RATIONALE,
  };
}

async function handleOpenViking(
  deps: {
    openviking: OpenVikingMemoryReads;
    offers: MemoryOffers;
    offerTargets?: MemoryOfferTargetResolver;
  },
  input: { workspaceId: string; agentId: string },
  command: OpenVikingAgentCommand,
): Promise<OpenVikingAgentResponse & MixedOfferCitationFields> {
  if (command.op === "find") {
    const items = await deps.openviking.find({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      operationId: command.operationId,
      query: command.query,
      ...(command.limit === undefined ? {} : { limit: command.limit }),
      ...(command.targetUri === undefined ? {} : { targetUri: command.targetUri }),
    });
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: command.operationId,
      duplicate: false,
      items,
    };
  }
  if (command.op === "search_context") {
    const items = await deps.openviking.searchContext({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      operationId: command.operationId,
      query: command.query,
      ...(command.limit === undefined ? {} : { limit: command.limit }),
      ...(command.targetUri === undefined ? {} : { targetUri: command.targetUri }),
      ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
    });
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId: command.operationId,
      duplicate: false,
      items,
    };
  }
  if (command.op === "read") {
    const read = await deps.openviking.read({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      operationId: command.operationId,
      uri: command.uri,
    });
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "read",
      operationId: command.operationId,
      duplicate: false,
      citation: read.citation,
      content: read.content,
    };
  }
  const delivery = await offerDelivery(deps, input, command);
  const offer = await deps.offers.publish({
    workspaceId: input.workspaceId,
    operationId: command.operationId,
    conversationId: delivery.conversationId,
    targetAgentId: delivery.targetAgentId,
    recipientRationale: delivery.recipientRationale,
    citationRefs: command.citationRefs,
    body: command.body,
    memoryAgentId: input.agentId,
  });
  const { causal, openviking } = splitOfferCitations(offer.citations);
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: command.operationId,
    published: true,
    duplicate: offer.duplicate,
    messageId: offer.offer.messageId,
    recipientAgentId: offer.offer.recipientAgentId,
    citations: openviking,
    causalCitations: causal.map(toLegacyCausalCitation),
  };
}

async function handleCausal(
  deps: {
    citations: MemoryCitationBindings;
    offers: MemoryOffers;
    causalRuntime: CausalRuntimeRead;
    tenantToken: (workspaceId: string) => Promise<string>;
    offerTargets?: MemoryOfferTargetResolver;
  },
  input: { workspaceId: string; agentId: string },
  command: CausalAgentCommand,
): Promise<CausalAgentResponse & MixedOfferCitationFields> {
  if (command.op === "search" || command.op === "trace" || command.op === "intervene") {
    const path =
      command.op === "search"
        ? CAUSAL_RUNTIME_ROUTES.search.path
        : command.op === "trace"
          ? CAUSAL_RUNTIME_ROUTES.trace.path
          : CAUSAL_RUNTIME_ROUTES.intervene.path;
    const body =
      command.op === "search"
        ? {
            protocol: CAUSAL_RUNTIME_PROTOCOL,
            operationId: command.operationId,
            query: command.query,
            ...(command.limit === undefined ? {} : { limit: command.limit }),
          }
        : command.op === "trace"
          ? {
              protocol: CAUSAL_RUNTIME_PROTOCOL,
              operationId: command.operationId,
              causalItemId: command.causalItemId,
            }
          : {
              protocol: CAUSAL_RUNTIME_PROTOCOL,
              operationId: command.operationId,
              action: command.action,
              ...(command.context === undefined ? {} : { context: command.context }),
            };
    const read = await deps.causalRuntime.request<{ duplicate?: boolean; items?: unknown[] }>(
      path,
      command.operationId,
      await deps.tenantToken(input.workspaceId),
      body,
    );
    const items = await deps.citations.bindCausalHits(
      input.workspaceId,
      command.operationId,
      Array.isArray(read.items) ? read.items : [],
    );
    return {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: command.op,
      operationId: command.operationId,
      duplicate: read.duplicate === true,
      items: items.map(toLegacyCausalCitation),
    };
  }
  if (command.op === "offer") {
    const delivery = await offerDelivery(deps, input, command);
    const offer = await deps.offers.publish({
      workspaceId: input.workspaceId,
      operationId: command.operationId,
      conversationId: delivery.conversationId,
      targetAgentId: delivery.targetAgentId,
      recipientRationale: delivery.recipientRationale,
      citationRefs: command.citationRefs,
      body: command.body,
      memoryAgentId: input.agentId,
    });
    const { causal, openviking } = splitOfferCitations(offer.citations);
    return {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "offer",
      operationId: command.operationId,
      published: true,
      duplicate: offer.duplicate,
      messageId: offer.offer.messageId,
      recipientAgentId: offer.offer.recipientAgentId,
      citations: causal.map(toLegacyCausalCitation),
      openvikingCitations: openviking,
    };
  }
  const proposal = await deps.offers.proposeCorrection({
    workspaceId: input.workspaceId,
    operationId: command.operationId,
    causalItemId: command.causalItemId,
    contradictoryCitationRefs: command.contradictoryCitationRefs,
    rationale: command.rationale,
  });
  return {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "propose_correction",
    operationId: command.operationId,
    accepted: proposal.accepted,
    duplicate: proposal.duplicate,
    proposalId: proposal.proposalId,
  };
}

function fenceAllows(
  fence: MemoryAgentToolProfile | undefined,
  command: CausalAgentCommand | OpenVikingAgentCommand,
): boolean {
  if (fence === OPENVIKING_TOOL_PROFILE) return command.protocol === OPENVIKING_AGENT_PROTOCOL;
  if (fence === CAUSAL_OPENVIKING_TOOL_PROFILE) return true;
  if (fence === CAUSAL_TOOL_PROFILE) return command.protocol === CAUSAL_AGENT_PROTOCOL;
  return false;
}

function decodeCommand(value: unknown): CausalAgentCommand | OpenVikingAgentCommand {
  if (value && typeof value === "object" && "protocol" in value) {
    const protocol = (value as { protocol?: unknown }).protocol;
    if (protocol === OPENVIKING_AGENT_PROTOCOL) return decodeOpenVikingAgentCommand(value);
    if (protocol === CAUSAL_AGENT_PROTOCOL) return decodeCausalAgentCommand(value);
  }
  throw new Error("invalid memory command");
}

function toLegacyCausalCitation(citation: CausalMemoryCitation): CausalCitation & MemoryCitation {
  return {
    kind: CAUSAL_MEMORY_CITATION_KIND,
    citationId: citation.citationId,
    causalItemId: citation.causalItemId,
    ...(citation.causalPathId === undefined ? {} : { causalPathId: citation.causalPathId }),
    factVersion: citation.factVersion,
    admittedSegmentId: citation.admittedSegmentId,
    sourceMessageIds: citation.sourceMessageIds,
    displayContent: citation.displayContent,
  };
}

function isCausalMemory(citation: MemoryCitation): citation is CausalMemoryCitation {
  return citation.kind === CAUSAL_MEMORY_CITATION_KIND;
}

function isOpenViking(citation: MemoryCitation): citation is OpenVikingCitation {
  return citation.kind === OPENVIKING_CITATION_KIND;
}

function splitOfferCitations(citations: MemoryCitation[]): {
  causal: CausalMemoryCitation[];
  openviking: OpenVikingCitation[];
} {
  return {
    causal: citations.filter(isCausalMemory),
    openviking: citations.filter(isOpenViking),
  };
}

function translateError(
  command: CausalAgentCommand | OpenVikingAgentCommand,
  error: unknown,
): MemoryAgentCommandResult {
  if (error instanceof MemoryAgentBudgetError)
    return failure(429, command.protocol, command.operationId, "budget", error.message);
  if (error instanceof MemoryCitationCorrectionError)
    return failure(400, command.protocol, command.operationId, "citation", error.message);
  if (error instanceof MemoryCitationUngroundedError)
    return failure(400, command.protocol, command.operationId, "citation", error.message);
  if (error instanceof MemoryAgentMutationError)
    return failure(403, command.protocol, command.operationId, "unauthorized", error.message);
  if (error instanceof MemoryOfferTargetError)
    return failure(400, command.protocol, command.operationId, "invalid", error.message);
  if (error instanceof CausalWorkspaceScopeError)
    return failure(403, command.protocol, command.operationId, "unauthorized");
  if (error instanceof MemoryAgentUnauthorizedError)
    return failure(403, command.protocol, command.operationId, "unauthorized");
  if (error instanceof Error && /^openviking upstream status \d+$/.test(error.message))
    return failure(400, command.protocol, command.operationId, "invalid", error.message);
  return failure(400, command.protocol, command.operationId, "invalid");
}

function failure(
  status: number,
  protocol: string,
  operationId: string | undefined,
  kind: "unauthorized" | "invalid" | "citation" | "budget",
  message?: string,
): MemoryAgentCommandResult {
  const isOpenViking = protocol === OPENVIKING_AGENT_PROTOCOL;
  const codes = {
    unauthorized: isOpenViking ? "openviking-unauthorized" : "causal-unauthorized",
    invalid: isOpenViking ? "openviking-request-invalid" : "causal-request-invalid",
    citation: isOpenViking ? "openviking-citation-ungrounded" : "causal-citation-ungrounded",
    budget: isOpenViking ? "openviking-budget-exhausted" : "causal-budget-exhausted",
  } as const;
  const messages = {
    unauthorized: "not the workspace Memory Agent",
    invalid: message ?? "invalid memory request",
    citation: message ?? "citation was not served",
    budget: message ?? "memory budget exhausted",
  };
  return {
    ok: false,
    status,
    protocol: isOpenViking ? OPENVIKING_AGENT_PROTOCOL : CAUSAL_AGENT_PROTOCOL,
    ...(operationId === undefined ? {} : { operationId }),
    code: codes[kind],
    message: messages[kind],
  };
}

function peekProtocol(value: unknown): string {
  if (value && typeof value === "object" && "protocol" in value) {
    const protocol = (value as { protocol?: unknown }).protocol;
    if (protocol === OPENVIKING_AGENT_PROTOCOL) return OPENVIKING_AGENT_PROTOCOL;
  }
  return CAUSAL_AGENT_PROTOCOL;
}

function peekOperationId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "operationId" in value) {
    const operationId = (value as { operationId?: unknown }).operationId;
    return typeof operationId === "string" ? operationId : undefined;
  }
  return undefined;
}

export function memoryAgentResultToResponse(result: MemoryAgentCommandResult): Response {
  if (result.ok) return Response.json(result.response);
  return Response.json(
    {
      protocol: result.protocol,
      ...(result.operationId === undefined ? {} : { operationId: result.operationId }),
      error: { code: result.code, message: result.message },
    },
    { status: result.status },
  );
}

export function triggerMessageIdFrom(request: Request, fallback: string): string {
  return request.headers.get(MEMORY_AGENT_TRIGGER_HEADER) ?? fallback;
}
