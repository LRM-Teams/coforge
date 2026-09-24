import type { Prisma } from "#src/generated/prisma/client";

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
