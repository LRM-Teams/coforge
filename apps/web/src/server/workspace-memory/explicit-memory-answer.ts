/**
 * An explicit @memory question is answered with memory_offer.
 * Citations stay workspace-scoped: a later question may reuse an earlier citation id.
 * The channel and recipient are bound here when the model omits them.
 */

import type { PrismaClient } from "../../../generated/client";

const EXPLICIT_MEMORY_QUESTION = /(?:^|\s)@memory\b/;

export const DEFAULT_OFFER_RATIONALE = "answers the explicit @memory question";

export function isExplicitMemoryQuestion(body: string, memoryAgentId?: string): boolean {
  if (EXPLICIT_MEMORY_QUESTION.test(body)) return true;
  return (
    memoryAgentId !== undefined &&
    memoryAgentId.length > 0 &&
    body.includes(`<@agent:${memoryAgentId}>`)
  );
}

export function channelSendNeedsMemoryOffer(input: {
  latestQuestionAt: Date | null;
  latestOfferAt: Date | null;
}): boolean {
  if (!input.latestQuestionAt) return false;
  if (!input.latestOfferAt) return true;
  return input.latestOfferAt.getTime() <= input.latestQuestionAt.getTime();
}

export class MemoryOfferTargetError extends Error {
  constructor(message = "memory offer delivery target is unresolved") {
    super(message);
    this.name = "MemoryOfferTargetError";
  }
}

export async function explicitMemoryQuestionRequiresOffer(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string; conversationId: string },
  isDesignated: (workspaceId: string, agentId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!(await isDesignated(input.workspaceId, input.agentId))) return false;
  const question = await latestExplicitMemoryQuestion(
    db,
    input.workspaceId,
    [input.conversationId],
    input.agentId,
  );
  if (!question) return false;
  const offer = await db.memoryOfferRecord.findFirst({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      createdAt: { gt: question.createdAt },
    },
    select: { id: true },
  });
  return offer === null;
}

export async function resolveUnansweredMemoryOfferTarget(
  db: PrismaClient,
  workspaceId: string,
  memoryAgentId: string,
): Promise<{ conversationId: string; targetAgentId: string } | null> {
  const memberships = await db.conversationMember.findMany({
    where: {
      workspaceId,
      agentId: memoryAgentId,
      leftAt: null,
      conversation: { channelName: { not: null }, archivedAt: null },
    },
    select: { conversationId: true },
  });
  const conversationIds = memberships.map((membership) => membership.conversationId);
  const question = await latestExplicitMemoryQuestion(
    db,
    workspaceId,
    conversationIds,
    memoryAgentId,
  );
  if (!question) return null;
  const offer = await db.memoryOfferRecord.findFirst({
    where: {
      workspaceId,
      conversationId: question.conversationId,
      createdAt: { gt: question.createdAt },
    },
    select: { id: true },
  });
  if (offer) return null;
  const peer = await db.conversationMember.findFirst({
    where: {
      workspaceId,
      conversationId: question.conversationId,
      leftAt: null,
      AND: [{ agentId: { not: null } }, { NOT: { agentId: memoryAgentId } }],
    },
    orderBy: { id: "asc" },
    select: { agentId: true },
  });
  if (!peer?.agentId) return null;
  return { conversationId: question.conversationId, targetAgentId: peer.agentId };
}

async function latestExplicitMemoryQuestion(
  db: PrismaClient,
  workspaceId: string,
  conversationIds: string[],
  memoryAgentId: string,
): Promise<{ conversationId: string; createdAt: Date } | null> {
  if (conversationIds.length === 0) return null;
  const rows = await db.message.findMany({
    where: {
      workspaceId,
      conversationId: { in: conversationIds },
      OR: [{ body: { contains: "@memory" } }, { body: { contains: `<@agent:${memoryAgentId}>` } }],
      sender: { userId: { not: null } },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { body: true, createdAt: true, conversationId: true },
  });
  const question = rows.find((row) => isExplicitMemoryQuestion(row.body, memoryAgentId));
  return question
    ? { conversationId: question.conversationId, createdAt: question.createdAt }
    : null;
}
