import type { PrismaClient } from "../../../generated/client";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";

export type MemoryOfferPublisher = {
  publish(input: {
    workspaceId: string;
    conversationId: string;
    memoryAgentId: string;
    recipientAgentId: string;
    body: string;
    requestId: string;
  }): Promise<{ messageId: string }>;
};

export function createPrismaMemoryOfferPublisher(db: PrismaClient): MemoryOfferPublisher {
  const conversations = new PrismaDirectConversationRepository(db);
  return {
    async publish(input) {
      const recipient = await db.agent.findFirst({
        where: { id: input.recipientAgentId, workspaceId: input.workspaceId },
        select: { name: true },
      });
      if (!recipient) throw new Error("offer recipient is not an active workspace Agent");
      const mention = `@${recipient.name}`;
      const body = input.body.includes(mention) ? input.body : `${mention} ${input.body}`;
      const saved = await conversations.sendAgentMessage(
        input.conversationId,
        input.memoryAgentId,
        body,
        undefined,
        undefined,
        [{ type: "agent", id: input.recipientAgentId, name: recipient.name }],
      );
      return { messageId: saved.id };
    },
  };
}

export function createPrismaMemoryOfferChannels(db: PrismaClient) {
  return {
    async isActiveChannelAgent(
      workspaceId: string,
      conversationId: string,
      agentId: string,
    ): Promise<boolean> {
      const row = await db.conversationMember.findFirst({
        where: {
          workspaceId,
          conversationId,
          agentId,
          leftAt: null,
          conversation: { workspaceId, channelName: { not: null }, archivedAt: null },
        },
        select: { id: true },
      });
      return row !== null;
    },
  };
}
