import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { leftoverMentionHandles } from "./unresolved-mentions.server";

/** How long the sender can act on a mention that did not reach its target. */
export const PENDING_MENTION_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What the sender can still do about one pending mention. */
export type MentionActionKind = "add";

/** One mention of a sent message that did not reach its target, as its sender sees it. */
export type PendingMentionActionView = {
  resolutionId: string;
  messageId: string;
  targetType: "user" | "agent";
  targetId: string;
  targetHandle: string;
  targetLabel: string;
  targetAvatarUrl: string | null;
  /** The channel the mention was sent in, by name. */
  channelName: string;
  availableActions: MentionActionKind[];
  expiresAt: Date;
};

/**
 * Records, in the send's transaction, one pending mention action for every `@handle` of the stored
 * body that names someone outside the conversation: a Workspace human, or a public Agent, who is
 * not an active member. The send turned every member's mention into a token, so a handle still
 * written as text never names a member. A private Agent is never a channel member, so it gets no
 * row. When a human and an Agent share the handle, the Agent is the one named, as in mention
 * resolution. A replay of the same message writes nothing new.
 */
export async function recordPendingMentionActions(
  tx: Pick<Prisma.TransactionClient, "workspaceMembership" | "agent" | "pendingMentionAction">,
  message: {
    id: string;
    workspaceId: string;
    conversationId: string;
    senderMemberId: string;
    body: string;
    createdAt: Date;
  },
): Promise<void> {
  const handles = leftoverMentionHandles(message.body);
  if (!handles.length) return;
  const [humans, agents] = await Promise.all([
    tx.workspaceMembership.findMany({
      where: { workspaceId: message.workspaceId, user: { username: { in: handles } } },
      select: { user: { select: { id: true, username: true } } },
    }),
    tx.agent.findMany({
      where: {
        workspaceId: message.workspaceId,
        name: { in: handles },
        visibility: AGENT_VISIBILITY.PUBLIC,
        ...ACTIVE_AGENT_WHERE,
      },
      select: { id: true, name: true },
    }),
  ]);
  const agentByHandle = new Map(agents.map((agent) => [agent.name, agent.id]));
  const userByHandle = new Map(humans.map(({ user }) => [user.username, user.id]));
  const expiresAt = new Date(message.createdAt.getTime() + PENDING_MENTION_ACTION_TTL_MS);
  const rows = handles.flatMap((handle) => {
    const agentId = agentByHandle.get(handle);
    const userId = agentId ? undefined : userByHandle.get(handle);
    if (!agentId && !userId) return [];
    return [
      {
        messageId: message.id,
        conversationId: message.conversationId,
        workspaceId: message.workspaceId,
        senderMemberId: message.senderMemberId,
        targetAgentId: agentId,
        targetUserId: userId,
        targetHandle: handle,
        expiresAt,
      },
    ];
  });
  if (rows.length) await tx.pendingMentionAction.createMany({ data: rows, skipDuplicates: true });
}

/**
 * The sender's still-pending mention actions of one message, in the order the body names them:
 * not yet acted on and not expired. What each still allows is read now: Add while the channel is
 * open and the target can join it and is not already a member.
 */
export async function pendingMentionActionsForMessage(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  message: {
    id: string;
    workspaceId: string;
    conversationId: string;
    senderMemberId: string;
    body: string;
  },
  channel: { archived: boolean; name: string },
  now: Date = new Date(),
): Promise<PendingMentionActionView[]> {
  const rows = await db.pendingMentionAction.findMany({
    where: {
      messageId: message.id,
      senderMemberId: message.senderMemberId,
      resolvedAt: null,
      expiresAt: { gt: now },
    },
    select: PENDING_MENTION_ACTION_SELECT,
  });
  if (!rows.length) return [];
  const members = await db.conversationMember.findMany({
    where: {
      conversationId: message.conversationId,
      ...ACTIVE_MEMBER_WHERE,
      OR: [
        { userId: { in: rows.flatMap((row) => (row.targetUserId ? [row.targetUserId] : [])) } },
        { agentId: { in: rows.flatMap((row) => (row.targetAgentId ? [row.targetAgentId] : [])) } },
      ],
    },
    select: { userId: true, agentId: true },
  });
  const memberIds = new Set(members.map((member) => member.userId ?? member.agentId));
  const order = leftoverMentionHandles(message.body);
  return rows
    .sort((left, right) => order.indexOf(left.targetHandle) - order.indexOf(right.targetHandle))
    .map((row) => pendingMentionActionView(row, message.workspaceId, channel, memberIds));
}

const PENDING_MENTION_ACTION_SELECT = {
  id: true,
  messageId: true,
  targetUserId: true,
  targetAgentId: true,
  targetHandle: true,
  expiresAt: true,
  targetUser: { select: { displayName: true, avatarObjectKey: true } },
  targetAgent: {
    select: { displayName: true, avatarObjectKey: true, visibility: true, deletedAt: true },
  },
} satisfies Prisma.PendingMentionActionSelect;

type PendingMentionActionRow = Prisma.PendingMentionActionGetPayload<{
  select: typeof PENDING_MENTION_ACTION_SELECT;
}>;

function pendingMentionActionView(
  row: PendingMentionActionRow,
  workspaceId: string,
  channel: { archived: boolean; name: string },
  memberIds: ReadonlySet<string | null>,
): PendingMentionActionView {
  const targetId = (row.targetAgentId ?? row.targetUserId)!;
  const agent = row.targetAgent;
  const canJoin = agent
    ? agent.visibility === AGENT_VISIBILITY.PUBLIC && agent.deletedAt === null
    : true;
  return {
    resolutionId: row.id,
    messageId: row.messageId,
    targetType: row.targetAgentId ? "agent" : "user",
    targetId,
    targetHandle: row.targetHandle,
    targetLabel:
      (agent ? agent.displayName : row.targetUser?.displayName)?.trim() || row.targetHandle,
    targetAvatarUrl: agent
      ? agentAvatarUrl(workspaceId, targetId, agent.avatarObjectKey)
      : workspaceUserAvatarUrl(workspaceId, targetId, row.targetUser?.avatarObjectKey ?? null),
    channelName: channel.name,
    availableActions: !channel.archived && canJoin && !memberIds.has(targetId) ? ["add"] : [],
    expiresAt: row.expiresAt,
  };
}

/** The outcome of one requested mention action: `delivered` when the target was added. */
export type MentionActionResult = {
  resolutionId: string;
  status: "delivered" | "stale" | "expired" | "no_permission" | "not_found";
  reason?:
    | "no_longer_pending"
    | "target_already_member"
    | "target_unavailable"
    | "sender_lacks_channel_access"
    | "channel_archived"
    | "could_not_apply";
  targetType?: "user" | "agent";
  targetId?: string;
};

/** One pending mention the sender may act on now, claimed for that action. */
export type ClaimedMentionAction = {
  resolutionId: string;
  conversationId: string;
  targetType: "user" | "agent";
  targetId: string;
};

/**
 * Checks each requested resolution id against its row and claims the ones the sender (`userId`)
 * can take `action` on now, so a concurrent or repeated request never acts on the same mention twice. A row
 * that is not this sender's is `not_found`, exactly like one that does not exist. The refusals come
 * back as results; the claimed rows are for the caller to carry out, and to `releaseMentionActions`
 * if it cannot.
 */
export async function claimMentionActions(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  userId: string,
  action: MentionActionKind,
  resolutionIds: readonly string[],
  now: Date = new Date(),
): Promise<{ refused: MentionActionResult[]; claimed: ClaimedMentionAction[] }> {
  const ids = [...new Set(resolutionIds)];
  const rows = await db.pendingMentionAction.findMany({
    where: { id: { in: ids }, workspaceId, sender: { userId } },
    select: {
      id: true,
      conversationId: true,
      targetUserId: true,
      targetAgentId: true,
      expiresAt: true,
      resolvedAt: true,
      sender: { select: { leftAt: true } },
      message: { select: { conversation: { select: { archivedAt: true } } } },
      targetAgent: { select: { visibility: true, deletedAt: true } },
    },
  });
  const members = await db.conversationMember.findMany({
    where: {
      conversationId: { in: [...new Set(rows.map((row) => row.conversationId))] },
      ...ACTIVE_MEMBER_WHERE,
      OR: [
        { userId: { in: rows.flatMap((row) => (row.targetUserId ? [row.targetUserId] : [])) } },
        { agentId: { in: rows.flatMap((row) => (row.targetAgentId ? [row.targetAgentId] : [])) } },
      ],
    },
    select: { conversationId: true, userId: true, agentId: true },
  });
  const memberKeys = new Set(
    members.map((member) => `${member.conversationId}:${member.userId ?? member.agentId}`),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const refused: MentionActionResult[] = [];
  const claimed: ClaimedMentionAction[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      refused.push({ resolutionId: id, status: "not_found" });
      continue;
    }
    const target = {
      targetType: row.targetAgentId ? ("agent" as const) : ("user" as const),
      targetId: (row.targetAgentId ?? row.targetUserId)!,
    };
    const refuse = (
      status: MentionActionResult["status"],
      reason?: MentionActionResult["reason"],
    ) => refused.push({ resolutionId: id, status, reason, ...target });
    if (row.resolvedAt) refuse("stale", "no_longer_pending");
    else if (row.expiresAt <= now) refuse("expired");
    else if (row.sender.leftAt) refuse("no_permission", "sender_lacks_channel_access");
    else if (row.message.conversation.archivedAt) refuse("no_permission", "channel_archived");
    else if (
      row.targetAgent &&
      (row.targetAgent.visibility !== AGENT_VISIBILITY.PUBLIC || row.targetAgent.deletedAt)
    )
      refuse("stale", "target_unavailable");
    else if (memberKeys.has(`${row.conversationId}:${target.targetId}`))
      refuse("stale", "target_already_member");
    else {
      // Claimed only while still pending: a concurrent request that got here first wins.
      const { count } = await db.pendingMentionAction.updateMany({
        where: { id, resolvedAt: null },
        data: { resolvedAt: now, resolvedAction: action },
      });
      if (count) claimed.push({ resolutionId: id, conversationId: row.conversationId, ...target });
      else refuse("stale", "no_longer_pending");
    }
  }
  return { refused, claimed };
}

/** Puts claimed mention actions back to pending, for a caller that could not carry them out. */
export async function releaseMentionActions(
  db: Pick<PrismaClient, "pendingMentionAction">,
  claimed: readonly ClaimedMentionAction[],
): Promise<void> {
  await db.pendingMentionAction.updateMany({
    where: { id: { in: claimed.map((action) => action.resolutionId) } },
    data: { resolvedAt: null, resolvedAction: null },
  });
}
