import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { pinOrdersAfterArrange } from "#src/lib/pin-order";
import { lockConversation } from "./conversation-lock.server";

/**
 * Pins or unpins one conversation for one member. A member's pins form a single order across
 * every channel and DM they have in the Workspace (the sidebar's Pinned section lists them
 * together), so a new pin goes after all of them. Pinning what is already pinned keeps its place
 * unless the caller supplies an order. Runs inside the caller's transaction, which holds
 * `lockMemberPins` and then the conversation's lock, in that order.
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

/** A pinned conversation as the sidebar addresses it: a channel by id, a DM by its Agent. */
export type ConversationPinRef =
  | { kind: "channel"; channelId: string }
  | { kind: "direct"; agentId: string };

/**
 * Puts the member's pins in the order a drag in the sidebar left them: `pins` take the first
 * places in that order (pinning any that are new), the conversations in `unpinned` are unpinned,
 * and any other pin the member has (one made in another tab, or on a chat not on screen) keeps
 * its relative place after them. Every entry of `pins` must be a channel or DM the member is
 * currently in; otherwise nothing changes and the call fails with `ACCESS_DENIED`.
 */
export async function arrangeConversationPins(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  arrangement: { pins: readonly ConversationPinRef[]; unpinned: readonly ConversationPinRef[] },
) {
  await db.$transaction(async (tx) => {
    await lockMemberPins(tx, workspaceId, userId);
    const resolved = await activeMemberships(tx, workspaceId, userId, arrangement.pins);
    if (resolved.some((member) => member === undefined)) throw new AppError("ACCESS_DENIED");
    // One place per conversation, the first the list gives it.
    const members = [...new Map(resolved.map((m) => [m!.conversationId, m!])).values()];
    // Every pin the member has now, read once: what is new, what moved, and what else to keep.
    const current = await tx.conversationPin.findMany({
      where: { workspaceId, member: { userId } },
      orderBy: { sortOrder: "asc" },
      select: { conversationId: true, memberId: true, sortOrder: true },
    });
    const pinnedNow = new Set(current.map((pin) => pin.conversationId));

    // A conversation being newly pinned is locked after the member lock (in id order, like every
    // other pin write): its new pin row needs the membership to still be there, and a leave takes
    // the same lock, so the memberships are checked again once it is held. Re-ordering existing
    // pins changes only their order and takes no conversation lock.
    const added = members.filter((member) => !pinnedNow.has(member.conversationId));
    for (const conversationId of added.map((member) => member.conversationId).sort())
      await lockConversation(tx, conversationId);
    if (added.length > 0) {
      const stillIn = await tx.conversationMember.count({
        where: { id: { in: added.map((member) => member.id) }, leftAt: null },
      });
      if (stillIn !== added.length) throw new AppError("ACCESS_DENIED");
    }

    const unpinned = new Set(
      (await activeMemberships(tx, workspaceId, userId, arrangement.unpinned)).flatMap((member) =>
        member ? [member.conversationId] : [],
      ),
    );
    // Every pin's new order (`null` = unpinned), by the rule the sidebar also applies on screen.
    const place = pinOrdersAfterArrange(
      current.map((pin) => ({ key: pin.conversationId, order: pin.sortOrder })),
      { pins: members.map((member) => member.conversationId), unpinned: [...unpinned] },
    );
    const removed = current.filter((pin) => place.get(pin.conversationId) === null);
    if (removed.length > 0)
      await tx.conversationPin.deleteMany({
        where: {
          workspaceId,
          member: { userId },
          conversationId: { in: removed.map((pin) => pin.conversationId) },
        },
      });
    if (added.length > 0)
      await tx.conversationPin.createMany({
        data: added.map((member) => ({
          conversationId: member.conversationId,
          memberId: member.id,
          workspaceId,
          sortOrder: place.get(member.conversationId) ?? 0,
        })),
      });
    // Only rows whose order changes are written, in one statement.
    const moved = current.flatMap((pin) => {
      const order = place.get(pin.conversationId);
      return order === undefined || order === null || order === pin.sortOrder
        ? []
        : [{ ...pin, order }];
    });
    if (moved.length > 0)
      await tx.$executeRaw`
        UPDATE "conversation_pins" AS p SET "sortOrder" = v."sortOrder"
        FROM unnest(
          ${moved.map((pin) => pin.conversationId)}::uuid[],
          ${moved.map((pin) => pin.memberId)}::uuid[],
          ${moved.map((pin) => pin.order)}::int[]
        ) AS v("conversationId", "memberId", "sortOrder")
        WHERE p."conversationId" = v."conversationId" AND p."memberId" = v."memberId"`;
  });
}

/** The member's active membership behind each ref, in order; `undefined` where the member is not
 * in that channel or has no DM with that Agent. */
async function activeMemberships(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  refs: readonly ConversationPinRef[],
) {
  if (refs.length === 0) return [];
  const channelIds = refs.flatMap((ref) => (ref.kind === "channel" ? [ref.channelId] : []));
  const agentIds = refs.flatMap((ref) => (ref.kind === "direct" ? [ref.agentId] : []));
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
  return refs.map((ref) =>
    ref.kind === "channel" ? byChannel.get(ref.channelId) : byAgent.get(ref.agentId),
  );
}

/** Serializes every change to one user's pins in a Workspace, so two changes never compute
 * their orders from the same snapshot. Take it before any conversation lock in the same
 * transaction, so pin writes never wait on each other in a cycle. `NO KEY UPDATE` leaves rows
 * that reference the membership free to be written meanwhile. */
export async function lockMemberPins(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const locked = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM "workspace_memberships"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "userId" = ${userId}::uuid
    FOR NO KEY UPDATE`;
  if (locked.length === 0) throw new AppError("ACCESS_DENIED");
}
