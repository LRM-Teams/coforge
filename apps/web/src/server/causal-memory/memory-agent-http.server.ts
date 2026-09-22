/**
 * Thin HTTP assembly for F4 Memory Agent routes. Routes stay adapters.
 */

import { readFileSync } from "node:fs";
import type { PrismaClient } from "../../../generated/client";
import { PrismaCausalMemoryRepository } from "../db/repositories/causal-memory.repositories.server";
import { PrismaOpenVikingBindingStore } from "../db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryCitationStore } from "../db/repositories/workspace-memory-citation.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../db/repositories/workspace-memory-profile.repositories.server";
import { createOpenVikingPolicyGateway } from "../openviking/policy-gateway.server";
import { createOpenVikingRuntimeClient } from "../openviking/runtime-client.server";
import { createMemoryAgentFenceLookup } from "../workspace-memory/memory-agent-fence";
import { resolveUnansweredMemoryOfferTarget } from "./explicit-memory-answer";
import { CAUSAL_RUNTIME_PROTOCOL, CAUSAL_RUNTIME_ROUTES } from "./contract";
import { createCausalRuntimeClient } from "./module";
import { causalMemoryRuntimeUrl, tenantTokenForWorkspace } from "./config.server";
import {
  createMemoryCitationBindings,
  createPrismaCausalMemoryCitationBindings,
} from "./memory-citations";
import { createMemoryAgentBudgetLedger } from "./memory-agent-budget";
import {
  createMemoryAgentCommands,
  memoryAgentResultToResponse,
  triggerMessageIdFrom,
  type MemoryAgentCommands,
  type MemoryAgentDirectory,
} from "./memory-agent-route";
import { createMemoryOffers, type CausalCorrectionPort } from "./memory-offers";
import { createPrismaCausalOfferPublisher } from "./offer-delivery.server";
import {
  createCatalogOpenVikingMemoryReadClient,
  type OpenVikingMemoryReadClient,
} from "../openviking/memory-agent-reads";
import { createOpenVikingMemoryReads } from "./openviking-memory-reads";

const budgets = createMemoryAgentBudgetLedger();

export function createPrismaMemoryAgentDirectory(db: PrismaClient): MemoryAgentDirectory {
  return {
    async isDesignated(workspaceId, agentId) {
      const tenant = await db.causalWorkspaceTenant.findUnique({
        where: { workspaceId },
        select: { memoryAgentId: true },
      });
      if (tenant?.memoryAgentId === agentId) return true;
      const mapped = await db.openVikingMappedIdentity.findFirst({
        where: { workspaceId, actorKind: "memory_agent", actorSubject: agentId },
        select: { id: true },
      });
      return mapped !== null;
    },
  };
}

export function createScopedCorrectionPort(input: {
  workspaceId: string;
  repo: PrismaCausalMemoryRepository;
  tenantToken: () => Promise<string>;
}): CausalCorrectionPort {
  const runtime = createCausalRuntimeClient(causalMemoryRuntimeUrl());
  return {
    async propose(command) {
      const existing = await input.repo.putProposal({
        workspaceId: input.workspaceId,
        proposalId: command.operationId,
        operationId: command.operationId,
        causalItemId: command.causalItemId,
        contradictoryCitationIds: command.citations.map((citation) => citation.citationId),
        rationale: command.rationale,
      });
      const first = command.citations[0]!;
      const verdict = await runtime.request<{
        verdict: "accept" | "reject";
        superseded: boolean;
        auditId: string;
      }>(
        CAUSAL_RUNTIME_ROUTES.adjudicateCorrection.path,
        command.operationId,
        await input.tenantToken(),
        {
          protocol: CAUSAL_RUNTIME_PROTOCOL,
          operationId: command.operationId,
          proposal: {
            causalItemId: command.causalItemId,
            contradictoryEvidence: {
              admittedSegmentId: first.admittedSegmentId,
              sourceMessageIds: [
                ...new Set(command.citations.flatMap((citation) => citation.sourceMessageIds)),
              ],
              summary: command.rationale,
            },
          },
        },
      );
      await input.repo.putSupersession({
        workspaceId: input.workspaceId,
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
    },
  };
}

export function createScopedMemoryAgentHttpCommands(
  db: PrismaClient,
  workspaceId: string,
  extras: {
    openvikingReads?: OpenVikingMemoryReadClient;
    directory?: MemoryAgentDirectory;
  } = {},
): MemoryAgentCommands {
  const profiles = new PrismaWorkspaceMemoryProfileStore(db);
  const citationsStore = new PrismaWorkspaceMemoryCitationStore(db);
  const causalRepo = new PrismaCausalMemoryRepository(db);
  const citations = createMemoryCitationBindings({
    openviking: citationsStore,
    causal: createPrismaCausalMemoryCitationBindings(causalRepo),
  });
  return createMemoryAgentCommands({
    fence: createMemoryAgentFenceLookup(profiles),
    directory: extras.directory ?? createPrismaMemoryAgentDirectory(db),
    budgets,
    citations,
    offers: createMemoryOffers({
      citations,
      offers: citationsStore,
      publisher: createPrismaCausalOfferPublisher(db),
      channels: causalRepo,
      corrections: createScopedCorrectionPort({
        workspaceId,
        repo: causalRepo,
        async tenantToken() {
          const tenant = await causalRepo.designatedMemoryAgent(workspaceId);
          if (!tenant) throw new Error("causal tenant is not provisioned");
          return tenantTokenForWorkspace(workspaceId, tenant.tenantId);
        },
      }),
    }),
    openviking: createOpenVikingMemoryReads({
      client: extras.openvikingReads ?? createDefaultOpenVikingReadClient(db),
      citations,
    }),
    causalRuntime: createCausalRuntimeClient(causalMemoryRuntimeUrl()),
    async tenantToken() {
      const tenant = await causalRepo.designatedMemoryAgent(workspaceId);
      if (!tenant) throw new Error("causal tenant is not provisioned");
      return tenantTokenForWorkspace(workspaceId, tenant.tenantId);
    },
    offerTargets: {
      resolve(currentWorkspaceId, memoryAgentId) {
        return resolveUnansweredMemoryOfferTarget(db, currentWorkspaceId, memoryAgentId);
      },
    },
  });
}

export async function handleMemoryAgentHttp(input: {
  db: PrismaClient;
  workspaceId: string;
  agentId: string;
  request: Request;
  body: unknown;
  commands?: MemoryAgentCommands;
}): Promise<Response> {
  const commands =
    input.commands ?? createScopedMemoryAgentHttpCommands(input.db, input.workspaceId);
  const operationId =
    input.body && typeof input.body === "object" && "operationId" in input.body
      ? String((input.body as { operationId?: unknown }).operationId ?? "memory")
      : "memory";
  const result = await commands.handle({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    triggerMessageId: triggerMessageIdFrom(input.request, operationId),
    command: input.body,
  });
  return memoryAgentResultToResponse(result);
}

function accountKeyFor(credentialRef: string): string | undefined {
  const path = Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;
  if (!path) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const key = raw[credentialRef];
  if (typeof key !== "string" || key.length === 0)
    throw new Error("openviking account key is missing");
  return key;
}

function createDefaultOpenVikingReadClient(db: PrismaClient): OpenVikingMemoryReadClient {
  const bindings = new PrismaOpenVikingBindingStore(db);
  const gateway = createOpenVikingPolicyGateway({
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    bindings,
    runtime: createOpenVikingRuntimeClient({
      baseUrl: Bun.env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:0",
    }),
    async resolveAuthorization(credentialRef) {
      if (!credentialRef.startsWith("secret:")) throw new Error("invalid credential ref");
      const token = accountKeyFor(credentialRef) ?? Bun.env.COFORGE_OPENVIKING_RUNTIME_TOKEN;
      if (!token) throw new Error("openviking runtime token is not configured");
      return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    },
  });
  return createCatalogOpenVikingMemoryReadClient({
    async forward(request) {
      const result = await gateway.forward(
        { kind: "memory_agent", agentId: request.agentId },
        {
          workspaceId: request.workspaceId,
          method: request.method,
          path: request.path,
          query: request.query,
          headers:
            request.body === undefined ? undefined : { "content-type": "application/json" },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        },
      );
      if (!result.ok) throw new Error(result.failure.message);
      if (result.response.status >= 400)
        throw new Error(`openviking upstream status ${result.response.status}`);
      const text = await new Response(result.response.body).text();
      const parsed = text ? JSON.parse(text) : {};
      const binding = await bindings.get(request.workspaceId);
      if (binding && parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return { ...parsed, accountId: binding.accountId };
      return parsed;
    },
  });
}
