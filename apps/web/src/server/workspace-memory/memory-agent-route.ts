/**
 * Memory Agent command composition for the Agent HTTPS routes.
 * OpenViking-only: reads and one cited Memory Offer per triggering message.
 */

import {
  decodeOpenVikingAgentCommand,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_PROFILE,
  type MemoryAgentToolProfile,
  type OpenVikingAgentCommand,
  type OpenVikingAgentResponse,
  type OpenVikingCitation,
} from "@lrm/coforge-sdk/agent";
import { WorkspaceMemoryScopeError } from "../db/repositories/workspace-memory-errors.server";
import { MemoryCitationUngroundedError, type MemoryCitationBindings } from "./memory-citations";
import { MemoryAgentBudgetError, type MemoryAgentBudgetLedger } from "./memory-agent-budget";
import type { MemoryOffers } from "./memory-offers";
import {
  MemoryAgentMutationError,
  type OpenVikingMemoryReads,
} from "../openviking/openviking-memory-reads";
import { DEFAULT_OFFER_RATIONALE, MemoryOfferTargetError } from "./explicit-memory-answer";

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

export type MemoryAgentCommandResult =
  | {
      ok: true;
      response: OpenVikingAgentResponse;
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
  offerTargets?: MemoryOfferTargetResolver;
}): MemoryAgentCommands {
  return {
    async handle(input) {
      if (!(await deps.directory.isDesignated(input.workspaceId, input.agentId))) {
        return failure(403, peekOperationId(input.command), "unauthorized");
      }
      let command: OpenVikingAgentCommand;
      try {
        command = decodeOpenVikingAgentCommand(input.command);
      } catch {
        return failure(400, peekOperationId(input.command), "invalid");
      }
      const fence = await deps.fence.resolve(input.workspaceId);
      if (!fenceAllows(fence, command)) {
        return failure(403, command.operationId, "unauthorized");
      }
      try {
        deps.budgets
          .forTrigger({
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            triggerMessageId: input.triggerMessageId,
          })
          .consume(command);
        return { ok: true, response: await handleOpenViking(deps, input, command) };
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
): Promise<OpenVikingAgentResponse> {
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
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: command.operationId,
    published: true,
    duplicate: offer.duplicate,
    messageId: offer.offer.messageId,
    recipientAgentId: offer.offer.recipientAgentId,
    citations: offer.citations as OpenVikingCitation[],
  };
}

function fenceAllows(
  fence: MemoryAgentToolProfile | undefined,
  command: OpenVikingAgentCommand,
): boolean {
  if (fence === OPENVIKING_TOOL_PROFILE) return command.protocol === OPENVIKING_AGENT_PROTOCOL;
  return false;
}

function translateError(command: OpenVikingAgentCommand, error: unknown): MemoryAgentCommandResult {
  if (error instanceof MemoryAgentBudgetError)
    return failure(429, command.operationId, "budget", error.message);
  if (error instanceof MemoryCitationUngroundedError)
    return failure(400, command.operationId, "citation", error.message);
  if (error instanceof MemoryAgentMutationError)
    return failure(403, command.operationId, "unauthorized", error.message);
  if (error instanceof MemoryOfferTargetError)
    return failure(400, command.operationId, "invalid", error.message);
  if (error instanceof WorkspaceMemoryScopeError)
    return failure(403, command.operationId, "unauthorized");
  if (error instanceof MemoryAgentUnauthorizedError)
    return failure(403, command.operationId, "unauthorized");
  if (error instanceof Error && /^openviking upstream status \d+$/.test(error.message))
    return failure(400, command.operationId, "invalid", error.message);
  return failure(400, command.operationId, "invalid");
}

function failure(
  status: number,
  operationId: string | undefined,
  kind: "unauthorized" | "invalid" | "citation" | "budget",
  message?: string,
): MemoryAgentCommandResult {
  const codes = {
    unauthorized: "openviking-unauthorized",
    invalid: "openviking-request-invalid",
    citation: "openviking-citation-ungrounded",
    budget: "openviking-budget-exhausted",
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
    protocol: OPENVIKING_AGENT_PROTOCOL,
    ...(operationId === undefined ? {} : { operationId }),
    code: codes[kind],
    message: messages[kind],
  };
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
