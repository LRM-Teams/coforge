import { createFileRoute } from "@tanstack/react-router";
import {
  CAUSAL_AGENT_PROTOCOL,
  decodeCausalAgentCommand,
  type CausalAgentResponse,
} from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { PrismaCausalMemoryRepository } from "#/server/db/repositories/causal-memory.repositories.server";
import {
  CausalCitationUngroundedError,
  CausalMemory,
  CausalRuntimeRequestError,
  createCausalRuntimeClient,
} from "#/server/causal-memory/module";
import {
  causalMemoryRuntimeUrl,
  tenantTokenForWorkspace,
} from "#/server/causal-memory/config.server";
import { CAUSAL_RUNTIME_PROTOCOL } from "#/server/causal-memory/contract";
import { createPrismaCausalOfferPublisher } from "#/server/causal-memory/offer-delivery.server";
import {
  CausalReplayConflictError,
  CausalWorkspaceScopeError,
} from "#/server/db/repositories/causal-memory.repositories.server";

export const Route = createFileRoute("/api/agent/v1/causal")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        try {
          const command = decodeCausalAgentCommand(await request.json());
          const tenants = new PrismaCausalMemoryRepository(db);
          const tenant = await tenants.designatedMemoryAgent(principal.workspaceId);
          if (!tenant?.enabled || tenant.memoryAgentId !== principal.agentId)
            return Response.json(
              {
                protocol: CAUSAL_AGENT_PROTOCOL,
                operationId: command.operationId,
                error: { code: "causal-unauthorized", message: "not the workspace Memory Agent" },
              },
              { status: 403 },
            );
          const memory = new CausalMemory(
            tenants,
            createCausalRuntimeClient(causalMemoryRuntimeUrl()),
            async () => tenantTokenForWorkspace(principal.workspaceId, tenant.tenantId),
            principal.workspaceId,
            createPrismaCausalOfferPublisher(db),
          );
          if (command.op === "search" || command.op === "trace" || command.op === "intervene") {
            const read =
              command.op === "search"
                ? await memory.search({
                    protocol: CAUSAL_RUNTIME_PROTOCOL,
                    operationId: command.operationId,
                    query: command.query,
                    ...(command.limit === undefined ? {} : { limit: command.limit }),
                  })
                : command.op === "trace"
                  ? await memory.trace({
                      protocol: CAUSAL_RUNTIME_PROTOCOL,
                      operationId: command.operationId,
                      causalItemId: command.causalItemId,
                    })
                  : await memory.intervene({
                      protocol: CAUSAL_RUNTIME_PROTOCOL,
                      operationId: command.operationId,
                      action: command.action,
                      ...(command.context === undefined ? {} : { context: command.context }),
                    });
            const response: CausalAgentResponse = {
              protocol: CAUSAL_AGENT_PROTOCOL,
              op: command.op,
              operationId: command.operationId,
              duplicate: read.duplicate,
              items: read.items,
            };
            return Response.json(response);
          }
          if (command.op === "offer") {
            const offer = await memory.publishOffer({
              ...command,
              memoryAgentId: principal.agentId,
            });
            const response: CausalAgentResponse = {
              protocol: CAUSAL_AGENT_PROTOCOL,
              op: "offer",
              operationId: command.operationId,
              published: true,
              duplicate: offer.duplicate,
              messageId: offer.messageId,
              recipientAgentId: offer.recipientAgentId,
              citations: offer.citations.map((citation) => ({
                citationId: citation.citationId,
                causalItemId: citation.causalItemId,
                causalPathId: citation.causalPathId,
                admittedSegmentId: citation.admittedSegmentId,
                sourceMessageIds: citation.sourceMessageIds,
                displayContent: citation.displayContent ?? "",
              })),
            };
            return Response.json(response);
          }
          const proposal = await memory.proposeCorrection(command);
          return Response.json({
            protocol: CAUSAL_AGENT_PROTOCOL,
            op: "propose_correction",
            operationId: command.operationId,
            accepted: proposal.accepted,
            duplicate: proposal.duplicate,
            proposalId: proposal.proposalId,
          });
        } catch (error) {
          if (error instanceof CausalCitationUngroundedError)
            return Response.json(
              {
                protocol: CAUSAL_AGENT_PROTOCOL,
                error: { code: "causal-citation-ungrounded", message: "citation was not served" },
              },
              { status: 400 },
            );
          if (error instanceof CausalWorkspaceScopeError)
            return Response.json(
              {
                protocol: CAUSAL_AGENT_PROTOCOL,
                error: {
                  code: "causal-unauthorized",
                  message: "recipient is not an active channel Agent",
                },
              },
              { status: 403 },
            );
          if (error instanceof CausalReplayConflictError)
            return Response.json(
              {
                protocol: CAUSAL_AGENT_PROTOCOL,
                error: { code: "causal-duplicate-conflict", message: "causal operation drifted" },
              },
              { status: 409 },
            );
          if (error instanceof CausalRuntimeRequestError)
            return Response.json(
              {
                protocol: CAUSAL_AGENT_PROTOCOL,
                error: {
                  code: "causal-runtime-unavailable",
                  message: "causal runtime unavailable",
                },
              },
              { status: 503 },
            );
          return Response.json(
            {
              protocol: CAUSAL_AGENT_PROTOCOL,
              error: { code: "causal-request-invalid", message: "invalid causal request" },
            },
            { status: 400 },
          );
        }
      },
    },
  },
});
