import type { PrismaClient, Prisma } from "../../../generated/client";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

/**
 * The managed Memory Agent identity lifecycle (ADR 0052-E/H).
 *
 * Enablement is the designation row (ADR 0052-H): enabling creates the
 * managed Workspace-scoped Agent, the designation, and its PublicChannel
 * memberships in one transaction; disabling soft-deletes the Agent and
 * removes the designation. The ingestion and distillation sweeps process
 * only designated Workspaces, so "off" is the absence of the row.
 *
 * Membership is reconciled, not hook-wired: `reconcileMemoryAgentMemberships`
 * idempotently ensures the designated Agent is a member of every PublicChannel
 * each sweep tick, which covers channels created after enablement without
 * touching the channel-creation path (derived-state discipline).
 */

const MEMORY_AGENT_NAME = "memory";
const MEMORY_AGENT_DISPLAY_NAME = "Memory";
const MEMORY_AGENT_DESCRIPTION =
  "Team memory explorer: searches the Workspace's Group Memory and shares relevant findings with @-mentioned teammates.";

export type MemoryAgentIdentity = {
  agentId: string;
  workspaceId: string;
};

export async function enableGroupMemory(
  db: PrismaClient,
  input: { workspaceId: string; ownerId: string; computerId?: string },
): Promise<MemoryAgentIdentity> {
  const existing = await db.memoryAgentDesignation.findUnique({
    where: { workspaceId: input.workspaceId },
    include: { agent: { select: { id: true, deletedAt: true } } },
  });
  if (existing && !existing.agent.deletedAt)
    return { agentId: existing.agentId, workspaceId: input.workspaceId };

  // A previous disable soft-deleted the identity but (workspaceId, name) stays
  // unique, so re-enable revives it: the Workspace's memory identity resumes
  // with its history (offers, messages) still linked.
  const designated = await db.$transaction(async (tx) => {
    const prior = await tx.agent.findUnique({
      where: { workspaceId_name: { workspaceId: input.workspaceId, name: MEMORY_AGENT_NAME } },
      select: { id: true, deletedAt: true },
    });
    let agentId: string;
    if (prior) {
      agentId = prior.id;
      await tx.agent.update({
        where: { id: agentId },
        data: {
          deletedAt: null,
          ownerId: input.ownerId,
          ...(input.computerId ? { computerId: input.computerId } : {}),
        },
        select: { id: true },
      });
    } else {
      const agent = await tx.agent.create({
        data: {
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          ...(input.computerId ? { computerId: input.computerId } : {}),
          name: MEMORY_AGENT_NAME,
          displayName: MEMORY_AGENT_DISPLAY_NAME,
          description: MEMORY_AGENT_DESCRIPTION,
          runtimeConfig: {
            runtime: RUNTIME_PROVIDER.COFORGE,
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
            toolProfile: { kind: "memory-explorer" },
          },
        },
        select: { id: true },
      });
      agentId = agent.id;
    }
    await tx.memoryAgentDesignation.upsert({
      where: { workspaceId: input.workspaceId },
      create: { workspaceId: input.workspaceId, agentId },
      update: { agentId },
      select: { id: true },
    });
    await enrollPublicChannels(tx, input.workspaceId, agentId);
    return agentId;
  });
  return { agentId: designated, workspaceId: input.workspaceId };
}

export async function disableGroupMemory(
  db: PrismaClient,
  input: { workspaceId: string },
): Promise<{ disabled: boolean }> {
  const existing = await db.memoryAgentDesignation.findUnique({
    where: { workspaceId: input.workspaceId },
  });
  if (!existing) return { disabled: false };
  await db.$transaction(async (tx) => {
    await tx.agent.update({
      where: { id: existing.agentId },
      data: { deletedAt: new Date() },
      select: { id: true },
    });
    await tx.memoryAgentDesignation.delete({
      where: { workspaceId: input.workspaceId },
      select: { id: true },
    });
  });
  return { disabled: true };
}

/**
 * Idempotent membership reconciliation: every designated (and live) Memory
 * Agent is a member of every PublicChannel in its Workspace (ADR 0052-E).
 * New members start already-read, so the Agent's unread badge counts only
 * messages sent after enrollment (the enrollment rule of #general).
 */
export async function reconcileMemoryAgentMemberships(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<{ enrolled: number }> {
  const designations = await db.memoryAgentDesignation.findMany({
    select: { workspaceId: true, agentId: true },
  });
  if (!designations.length) return { enrolled: 0 };
  let enrolled = 0;
  for (const designation of designations) {
    const agent = await db.agent.findUnique({
      where: { id: designation.agentId },
      select: { deletedAt: true },
    });
    if (!agent || agent.deletedAt) continue;
    enrolled += await enrollPublicChannels(
      db as Prisma.TransactionClient,
      designation.workspaceId,
      designation.agentId,
    );
  }
  return { enrolled };
}

async function enrollPublicChannels(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
): Promise<number> {
  const channels = await tx.conversation.findMany({
    where: { workspaceId, channelName: { not: null } },
    select: { id: true },
  });
  if (!channels.length) return 0;
  const memberships = await tx.conversationMember.findMany({
    where: { workspaceId, agentId, conversationId: { in: channels.map((c) => c.id) } },
    select: { conversationId: true },
  });
  const present = new Set(memberships.map((m) => m.conversationId));
  const missing = channels.filter((channel) => !present.has(channel.id));
  if (!missing.length) return 0;
  const rows = [];
  for (const channel of missing) {
    const latest = await tx.message.findFirst({
      where: { conversationId: channel.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const readThroughSequence = latest?.sequence ?? 0;
    rows.push({
      workspaceId,
      conversationId: channel.id,
      agentId,
      readThroughSequence,
      agentReadThroughSequence: readThroughSequence,
    });
  }
  const result = await tx.conversationMember.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return result.count;
}
