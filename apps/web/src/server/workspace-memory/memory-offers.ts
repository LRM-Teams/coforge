/**
 * Memory Offer composition. An offer is a cited channel message to one
 * recipient Agent; it never writes OpenViking.
 */

import type { MemoryCitation } from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  WorkspaceMemoryCitationStore,
} from "../db/repositories/workspace-memory-citation.repositories.server";
import { WorkspaceMemoryCitationKindError } from "../db/repositories/workspace-memory-errors.server";
import { WorkspaceMemoryScopeError } from "../db/repositories/workspace-memory-errors.server";
import type { MemoryOfferPublisher } from "./offer-delivery.server";
import { MemoryCitationUngroundedError, type MemoryCitationBindings } from "./memory-citations";

export type MemoryOfferResult = {
  offer: MemoryOfferRecord;
  citations: MemoryCitation[];
  duplicate: boolean;
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
};

export function createMemoryOffers(deps: {
  citations: MemoryCitationBindings;
  offers: Pick<WorkspaceMemoryCitationStore, "putOffer" | "getOffer">;
  publisher: MemoryOfferPublisher;
  channels: MemoryOfferChannel;
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
      if (!active) throw new WorkspaceMemoryScopeError();
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
  };
}
