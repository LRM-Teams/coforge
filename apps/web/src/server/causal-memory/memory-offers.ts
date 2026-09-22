/**
 * F4 Memory Offer + correction composition. Mixed citation kinds stay tagged.
 * Correction is a proposal against Causal Memory only; it never writes OpenViking.
 */

import {
  CAUSAL_MEMORY_CITATION_KIND,
  type CausalMemoryCitation,
  type MemoryCitation,
} from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  WorkspaceMemoryCitationStore,
} from "../db/repositories/workspace-memory-citation.repositories.server";
import { WorkspaceMemoryCitationKindError } from "../db/repositories/workspace-memory-errors.server";
import { CausalWorkspaceScopeError } from "../db/repositories/causal-memory.repositories.server";
import type { CausalOfferPublisher } from "./offer-delivery.server";
import {
  MemoryCitationCorrectionError,
  MemoryCitationUngroundedError,
  type MemoryCitationBindings,
} from "./memory-citations";

export type MemoryOfferResult = {
  offer: MemoryOfferRecord;
  citations: MemoryCitation[];
  duplicate: boolean;
};

export type CausalCorrectionPort = {
  propose(input: {
    operationId: string;
    causalItemId: string;
    citations: CausalMemoryCitation[];
    rationale: string;
  }): Promise<{ accepted: boolean; duplicate: boolean; proposalId: string }>;
};

export type MemoryOfferChannel = {
  isActiveChannelAgent(
    workspaceId: string,
    conversationId: string,
    agentId: string,
  ): Promise<boolean>;
};

export type MemoryOffers = {
  publish(input: {
    workspaceId: string;
    operationId: string;
    conversationId: string;
    targetAgentId: string;
    recipientRationale: string;
    citationRefs: string[];
    body: string;
    memoryAgentId: string;
  }): Promise<MemoryOfferResult>;
  proposeCorrection(input: {
    workspaceId: string;
    operationId: string;
    causalItemId: string;
    contradictoryCitationRefs: string[];
    rationale: string;
  }): Promise<{ accepted: boolean; duplicate: boolean; proposalId: string }>;
};

export function createMemoryOffers(deps: {
  citations: MemoryCitationBindings;
  offers: Pick<WorkspaceMemoryCitationStore, "putOffer" | "getOffer">;
  publisher: CausalOfferPublisher;
  channels: MemoryOfferChannel;
  corrections: CausalCorrectionPort;
}): MemoryOffers {
  return {
    async publish(input) {
      const citations = await deps.citations.resolveOfferCitations(
        input.workspaceId,
        input.citationRefs,
      );
      const existing = await deps.offers.getOffer(input.workspaceId, input.operationId);
      if (existing) return { offer: existing, citations, duplicate: true };
      const active = await deps.channels.isActiveChannelAgent(
        input.workspaceId,
        input.conversationId,
        input.targetAgentId,
      );
      if (!active) throw new CausalWorkspaceScopeError();
      const delivered = await deps.publisher.publish({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        memoryAgentId: input.memoryAgentId,
        recipientAgentId: input.targetAgentId,
        body: input.body,
        requestId: input.operationId,
      });
      try {
        const saved = await deps.offers.putOffer({
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          conversationId: input.conversationId,
          recipientAgentId: input.targetAgentId,
          recipientRationale: input.recipientRationale,
          messageId: delivered.messageId,
          citations: deps.citations.toOfferRefs(citations),
        });
        return { offer: saved.offer, citations, duplicate: saved.outcome === "replay" };
      } catch (error) {
        if (error instanceof WorkspaceMemoryCitationKindError)
          throw new MemoryCitationUngroundedError();
        throw error;
      }
    },

    async proposeCorrection(input) {
      const evidence = await deps.citations.resolveCorrectionEvidence(
        input.workspaceId,
        input.contradictoryCitationRefs,
      );
      if (evidence.some((citation) => citation.kind !== CAUSAL_MEMORY_CITATION_KIND))
        throw new MemoryCitationCorrectionError();
      return deps.corrections.propose({
        operationId: input.operationId,
        causalItemId: input.causalItemId,
        citations: evidence,
        rationale: input.rationale,
      });
    },
  };
}
