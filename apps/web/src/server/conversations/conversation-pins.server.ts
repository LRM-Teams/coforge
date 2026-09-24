import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

/**
 * Pins or unpins one conversation for one member. A member's pins form a single order across
 * every channel and DM they have in the Workspace (the sidebar's Pinned section lists them
 * together), so a new pin goes after all of them. Pinning what is already pinned keeps its place
 * unless the caller supplies an order. Runs inside the caller's transaction, after its
 * conversation lock.
 */
export async function setConversationPin(
  tx: Prisma.TransactionClient,
  pin: { workspaceId: string; userId: string; conversationId: string; memberId: string },
  pinned: boolean,
  sortOrder?: number,
) {
  const { workspaceId, userId, conversationId, memberId } = pin;
  const key = { conversationId, memberId };
  if (!pinned) {
    await tx.conversationPin.deleteMany({ where: key });
    return;
  }
  if (sortOrder === undefined) {
    const existing = await tx.conversationPin.findUnique({
      where: { conversationId_memberId: key },
      select: { sortOrder: true },
    });
    if (existing) return;
  }
  await lockMemberPins(tx, workspaceId, userId);
  const order = sortOrder ?? (await nextPinOrder(tx, workspaceId, userId));
  await tx.conversationPin.upsert({
    where: { conversationId_memberId: key },
    create: { conversationId, memberId, workspaceId, sortOrder: order },
    update: { sortOrder: order },
  });
}

/** One past the highest order among the user's pins in this Workspace. `memberId` is a
 * per-conversation membership row, so the user's pins are found through the member's user. */
async function nextPinOrder(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  const { _max } = await tx.conversationPin.aggregate({
    where: { workspaceId, member: { userId } },
    _max: { sortOrder: true },
  });
  return (_max.sortOrder ?? -1) + 1;
}

/** A pinned conversation as the sidebar addresses it: a channel by id, a DM by its Agent. */
export type ConversationPinRef =
  | { kind: "channel"; channelId: string }
  | { kind: "direct"; agentId: string };

/**
 * Makes `pins` the member's complete pin list, in that order: what is new gets pinned, what is
 * left out gets unpinned, and every pin's order becomes its position. This is what a drag in the
 * sidebar's Pinned section commits. Every entry must be a channel or DM the member is currently
 * in; otherwise nothing changes and the call fails with `ACCESS_DENIED`.
 */
export async function replaceConversationPins(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  pins: readonly ConversationPinRef[],
) {
  const channelIds = pins.flatMap((pin) => (pin.kind === "channel" ? [pin.channelId] : []));
  const agentIds = pins.flatMap((pin) => (pin.kind === "direct" ? [pin.agentId] : []));
  await db.$transaction(async (tx) => {
    await lockMemberPins(tx, workspaceId, userId);
    const members = await tx.conversationMember.findMany({
      where: {
        workspaceId,
        userId,
        leftAt: null,
        OR: [
          { conversationId: { in: channelIds }, conversation: { channelName: { not: null } } },
          {
            conversation: {
              directKey: { not: null },
              members: { some: { agentId: { in: agentIds } } },
            },
          },
        ],
      },
      select: {
        id: true,
        conversationId: true,
        conversation: {
          select: {
            channelName: true,
            members: { where: { agentId: { in: agentIds } }, select: { agentId: true } },
          },
        },
      },
    });
    const byChannel = new Map(
      members.filter((m) => m.conversation.channelName !== null).map((m) => [m.conversationId, m]),
    );
    const byAgent = new Map(
      members
        .filter((m) => m.conversation.channelName === null)
        .flatMap((m) => m.conversation.members.map((agent) => [agent.agentId!, m] as const)),
    );
    const resolved = pins.map((pin) =>
      pin.kind === "channel" ? byChannel.get(pin.channelId) : byAgent.get(pin.agentId),
    );
    if (resolved.some((member) => member === undefined)) throw new AppError("ACCESS_DENIED");
    const kept = resolved.map((member) => member!.conversationId);
    await tx.conversationPin.deleteMany({
      where: { workspaceId, member: { userId }, conversationId: { notIn: kept } },
    });
    for (const [sortOrder, member] of resolved.entries()) {
      const key = { conversationId: member!.conversationId, memberId: member!.id };
      await tx.conversationPin.upsert({
        where: { conversationId_memberId: key },
        create: { ...key, workspaceId, sortOrder },
        update: { sortOrder },
      });
    }
  });
}

/** Serializes every change to one user's pins in a Workspace, so two changes never compute
 * their orders from the same snapshot. `NO KEY UPDATE` leaves rows that reference the
 * membership free to be written meanwhile. */
async function lockMemberPins(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  const locked = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM "workspace_memberships"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "userId" = ${userId}::uuid
    FOR NO KEY UPDATE`;
  if (locked.length === 0) throw new AppError("ACCESS_DENIED");
}
