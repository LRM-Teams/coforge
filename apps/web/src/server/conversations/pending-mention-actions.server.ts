import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { leftoverMentionHandles } from "./unresolved-mentions.server";
import { channelTarget, encodeAgentDelivery } from "./agent-delivery.server";
import { MESSAGE_MENTIONS_SELECT } from "./mentions.server";
import { agentMessageSender } from "./sender-display.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";

/** How long the sender can act on a mention that did not reach its target. */
export const PENDING_MENTION_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What the sender can still do about one pending mention. */
export type MentionActionKind = "notify" | "add";

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
 * row. When a human and a public Agent share the handle, the Agent is the one named, as in mention
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
 * open and the target can join it and is not already a member, and Notify until it was notified.
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
  // A body with no `@handle` still written as text has no row: no query.
  const order = leftoverMentionHandles(message.body);
  if (!order.length) return [];
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
  notifiedAt: true,
  workspaceId: true,
  targetUser: {
    select: {
      displayName: true,
      avatarObjectKey: true,
      memberships: { select: { workspaceId: true } },
    },
  },
  targetAgent: {
    select: { displayName: true, avatarObjectKey: true, visibility: true, deletedAt: true },
  },
} satisfies Prisma.PendingMentionActionSelect;

/**
 * Whether a pending mention's target can still become a channel member: a human still in the
 * Workspace, or an Agent that is public and not deleted.
 */
function canJoinChannel(row: {
  targetAgent: { visibility: string; deletedAt: Date | null } | null;
  /** The target human's memberships of the mention's own Workspace. */
  targetUser: { memberships: readonly unknown[] } | null;
}): boolean {
  if (row.targetAgent)
    return row.targetAgent.visibility === AGENT_VISIBILITY.PUBLIC && !row.targetAgent.deletedAt;
  return Boolean(row.targetUser?.memberships.length);
}

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
  const canJoin = canJoinChannel({
    targetAgent: agent,
    targetUser: row.targetUser && {
      memberships: row.targetUser.memberships.filter(
        (membership) => membership.workspaceId === row.workspaceId,
      ),
    },
  });
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
    // Notify once, add any time: a notified target can still be added. Whether the sender may add
    // is decided when they try.
    availableActions:
      !channel.archived && canJoin && !memberIds.has(targetId)
        ? row.notifiedAt
          ? ["add"]
          : ["notify", "add"]
        : [],
    expiresAt: row.expiresAt,
  };
}

/** The outcome of one requested mention action: `delivered` when the target was added, `queued`
 * when it was notified. */
export type MentionActionResult = {
  resolutionId: string;
  status: "delivered" | "queued" | "stale" | "expired" | "no_permission" | "not_found";
  reason?:
    | "no_longer_pending"
    | "target_already_member"
    | "target_unavailable"
    | "sender_lacks_channel_access"
    | "channel_archived"
    | "could_not_apply"
    | "add_requires_human_member_authority"
    | "already_queued";
  targetType?: "user" | "agent";
  targetId?: string;
  /** The `@handle` the sender wrote, without the `@`. */
  targetHandle?: string;
};

/** One pending mention the sender may act on now, claimed for that action. */
export type ClaimedMentionAction = {
  resolutionId: string;
  conversationId: string;
  targetType: "user" | "agent";
  targetId: string;
  targetHandle: string;
};

type MentionActor = { userId: string } | { agentId: string };

/** Each requested row the sender owns, with what deciding and carrying out an action needs. */
async function loadActionRows(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  sender: MentionActor,
  ids: readonly string[],
) {
  const rows = await db.pendingMentionAction.findMany({
    where: {
      id: { in: [...ids] },
      workspaceId,
      sender: "userId" in sender ? { userId: sender.userId } : { agentId: sender.agentId },
    },
    select: {
      id: true,
      messageId: true,
      conversationId: true,
      targetUserId: true,
      targetAgentId: true,
      targetHandle: true,
      expiresAt: true,
      resolvedAt: true,
      notifiedAt: true,
      sender: { select: { leftAt: true } },
      message: { select: { sequence: true, conversation: { select: { archivedAt: true } } } },
      targetAgent: { select: { visibility: true, deletedAt: true } },
      targetUser: { select: { memberships: { where: { workspaceId }, select: { userId: true } } } },
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
  return { byId: new Map(rows.map((row) => [row.id, row])), memberKeys };
}

type ActionRow = NonNullable<ReturnType<Awaited<ReturnType<typeof loadActionRows>>["byId"]["get"]>>;

function actionTarget(row: ActionRow) {
  return {
    targetType: row.targetAgentId ? ("agent" as const) : ("user" as const),
    targetId: (row.targetAgentId ?? row.targetUserId)!,
    targetHandle: row.targetHandle,
  };
}

/** Why an action on this row cannot be taken now, or `undefined` when it can. The same rules for
 * Notify and Add. */
function actionRefusal(
  row: ActionRow,
  memberKeys: ReadonlySet<string>,
  now: Date,
): Pick<MentionActionResult, "status" | "reason"> | undefined {
  if (row.resolvedAt) return { status: "stale", reason: "no_longer_pending" };
  if (row.expiresAt <= now) return { status: "expired" };
  if (row.sender.leftAt) return { status: "no_permission", reason: "sender_lacks_channel_access" };
  if (row.message.conversation.archivedAt)
    return { status: "no_permission", reason: "channel_archived" };
  if (!canJoinChannel(row)) return { status: "stale", reason: "target_unavailable" };
  if (memberKeys.has(`${row.conversationId}:${actionTarget(row).targetId}`))
    return { status: "stale", reason: "target_already_member" };
  return undefined;
}

/**
 * Checks each requested resolution id against its row and claims the ones the sender can add now,
 * so a concurrent or repeated request never adds the same target twice. A row that is not this
 * sender's is `not_found`, exactly like one that does not exist. The refusals come back as results;
 * the claimed rows are for the caller to carry out, and to `releaseMentionActions` if it cannot.
 */
export async function claimMentionActions(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  sender: MentionActor,
  resolutionIds: readonly string[],
  now: Date = new Date(),
): Promise<{ refused: MentionActionResult[]; claimed: ClaimedMentionAction[] }> {
  const ids = [...new Set(resolutionIds)];
  const { byId, memberKeys } = await loadActionRows(db, workspaceId, sender, ids);
  const refused: MentionActionResult[] = [];
  const claimed: ClaimedMentionAction[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      refused.push({ resolutionId: id, status: "not_found" });
      continue;
    }
    const target = actionTarget(row);
    const refusal = actionRefusal(row, memberKeys, now);
    if (refusal) {
      refused.push({ resolutionId: id, ...refusal, ...target });
      continue;
    }
    // Claimed only while still pending: a concurrent request that got here first wins.
    const { count } = await db.pendingMentionAction.updateMany({
      where: { id, resolvedAt: null },
      data: { resolvedAt: now, resolvedAction: "add" },
    });
    if (count) claimed.push({ resolutionId: id, conversationId: row.conversationId, ...target });
    else
      refused.push({ resolutionId: id, status: "stale", reason: "no_longer_pending", ...target });
  }
  return { refused, claimed };
}

/** A notification that must still reach an Agent's daemon, once its delivery row exists. */
export type NonMemberDelivery = { deliveryId: string; agentId: string; messageId: string };

/**
 * Has each requested mention's target notified without adding them: the target's reading of that
 * one message, not of the channel. An Agent target gets the message as a delivery marked as
 * reaching it from outside the channel; a person finds it in their Activity inbox. The mention
 * stays pending, so the target can still be added; a repeat is `queued` with `already_queued`.
 * Returns the results in request order, and the new deliveries for the caller to publish.
 */
export async function notifyMentionTargets(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember" | "agentMessageDelivery">,
  workspaceId: string,
  sender: MentionActor,
  resolutionIds: readonly string[],
  now: Date = new Date(),
): Promise<{
  results: MentionActionResult[];
  deliveries: NonMemberDelivery[];
  /** People newly notified, whose Activity inbox changed. */
  notifiedUserIds: string[];
}> {
  const ids = [...new Set(resolutionIds)];
  const { byId, memberKeys } = await loadActionRows(db, workspaceId, sender, ids);
  const results: MentionActionResult[] = [];
  const deliveries: NonMemberDelivery[] = [];
  const notifiedUserIds = new Set<string>();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      results.push({ resolutionId: id, status: "not_found" });
      continue;
    }
    const target = actionTarget(row);
    const refusal = actionRefusal(row, memberKeys, now);
    if (refusal) {
      results.push({ resolutionId: id, ...refusal, ...target });
      continue;
    }
    // The Agent's delivery exists before the mention reads as notified, so a failure in between
    // leaves it pending and a retry delivers; the delivery itself is written once per message.
    const delivery = row.targetAgentId
      ? await db.agentMessageDelivery.upsert({
          where: { messageId_agentId: { messageId: row.messageId, agentId: row.targetAgentId } },
          create: {
            messageId: row.messageId,
            agentId: row.targetAgentId,
            workspaceId,
            conversationId: row.conversationId,
            sequence: row.message.sequence,
          },
          update: {},
          select: { deliveryId: true },
        })
      : undefined;
    // Notified only once: a concurrent or repeated request finds it already queued.
    const { count } = await db.pendingMentionAction.updateMany({
      where: { id, resolvedAt: null, notifiedAt: null },
      data: { notifiedAt: now },
    });
    if (!count) {
      results.push({ resolutionId: id, status: "queued", reason: "already_queued", ...target });
      continue;
    }
    if (delivery && row.targetAgentId)
      deliveries.push({
        deliveryId: delivery.deliveryId,
        agentId: row.targetAgentId,
        messageId: row.messageId,
      });
    if (row.targetUserId) notifiedUserIds.add(row.targetUserId);
    results.push({ resolutionId: id, status: "queued", ...target });
  }
  return { results, deliveries, notifiedUserIds: [...notifiedUserIds] };
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

/**
 * An Agent's still-pending mention actions across every channel it sent in: not acted on and not
 * expired, oldest message first and, within a message, in the order its body names them, each with
 * what it still allows.
 */
export async function pendingMentionActionsForAgent(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<PendingMentionActionView[]> {
  const rows = await db.pendingMentionAction.findMany({
    where: { workspaceId, sender: { agentId }, resolvedAt: null, expiresAt: { gt: now } },
    select: {
      ...PENDING_MENTION_ACTION_SELECT,
      conversationId: true,
      createdAt: true,
      message: {
        select: { body: true, conversation: { select: { channelName: true, archivedAt: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const members = rows.length
    ? await db.conversationMember.findMany({
        where: {
          conversationId: { in: [...new Set(rows.map((row) => row.conversationId))] },
          ...ACTIVE_MEMBER_WHERE,
          OR: [
            { userId: { in: rows.flatMap((row) => (row.targetUserId ? [row.targetUserId] : [])) } },
            {
              agentId: {
                in: rows.flatMap((row) => (row.targetAgentId ? [row.targetAgentId] : [])),
              },
            },
          ],
        },
        select: { conversationId: true, userId: true, agentId: true },
      })
    : [];
  const memberKeys = new Set(
    members.map((member) => `${member.conversationId}:${member.userId ?? member.agentId}`),
  );
  const orderInBody = (row: (typeof rows)[number]) =>
    leftoverMentionHandles(row.message.body).indexOf(row.targetHandle);
  return rows
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        (left.messageId === right.messageId ? orderInBody(left) - orderInBody(right) : 0),
    )
    .map((row) =>
      pendingMentionActionView(
        row,
        workspaceId,
        {
          archived: row.message.conversation.archivedAt !== null,
          name: row.message.conversation.channelName ?? "",
        },
        new Set(
          [row.targetUserId ?? row.targetAgentId].filter((targetId) =>
            memberKeys.has(`${row.conversationId}:${targetId}`),
          ),
        ),
      ),
    );
}

/**
 * An Agent's request to add the targets of its pending mentions. Adding a member is a human's
 * decision, so every one of the Agent's own mentions is refused with that reason; an id that is not the Agent's is
 * `not_found`, exactly like one that does not exist. Results in request order, one per distinct id.
 */
export async function refuseAgentMentionAdds(
  db: Pick<PrismaClient, "pendingMentionAction">,
  workspaceId: string,
  agentId: string,
  resolutionIds: readonly string[],
): Promise<MentionActionResult[]> {
  const ids = [...new Set(resolutionIds)];
  const rows = await db.pendingMentionAction.findMany({
    where: { id: { in: ids }, workspaceId, sender: { agentId } },
    select: { id: true, targetUserId: true, targetAgentId: true, targetHandle: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id): MentionActionResult => {
    const row = byId.get(id);
    if (!row) return { resolutionId: id, status: "not_found" };
    return {
      resolutionId: id,
      status: "no_permission",
      reason: "add_requires_human_member_authority",
      targetType: row.targetAgentId ? "agent" : "user",
      targetId: (row.targetAgentId ?? row.targetUserId)!,
      targetHandle: row.targetHandle,
    };
  });
}

/**
 * Hands each new non-member delivery to its Agent's daemon, as the send path does for a member:
 * the message as the Agent reads it, marked as a personal notification that reached it from
 * outside the channel. Best effort: the delivery row is what counts, and the daemon's recovery
 * replays one it missed.
 */
export async function publishNonMemberDeliveries(
  db: Pick<PrismaClient, "agentMessageDelivery">,
  publisher: Pick<CentrifugoServerApi, "publish">,
  workspaceId: string,
  deliveries: readonly NonMemberDelivery[],
): Promise<void> {
  if (!deliveries.length) return;
  const rows = await db.agentMessageDelivery.findMany({
    where: { deliveryId: { in: deliveries.map((delivery) => delivery.deliveryId) }, workspaceId },
    select: {
      deliveryId: true,
      agentId: true,
      sequence: true,
      agent: { select: { computerId: true } },
      message: {
        select: {
          id: true,
          conversationId: true,
          threadRootId: true,
          body: true,
          mentions: MESSAGE_MENTIONS_SELECT,
          conversation: { select: { channelName: true } },
          sender: {
            select: {
              agentId: true,
              agent: { select: { name: true, description: true } },
              user: { select: { username: true, description: true } },
            },
          },
        },
      },
    },
  });
  await Promise.all(
    rows
      .filter((row) => row.agent.computerId)
      .map(async (row) => {
        const sender = agentMessageSender(row.message.sender);
        try {
          await publisher.publish(
            daemonControlChannel(workspaceId, row.agent.computerId!),
            encodeAgentDelivery({
              requestId: row.deliveryId,
              workspaceId,
              conversationId: row.message.conversationId,
              agentId: row.agentId,
              messageId: row.message.id,
              deliveryId: row.deliveryId,
              sequence: row.sequence,
              body: row.message.body,
              mentions: row.message.mentions,
              target: `${channelTarget(row.message.conversation.channelName ?? "")}${row.message.threadRootId ? `:${row.message.threadRootId}` : ""}`,
              latestSenderKind: sender.kind,
              latestSenderHandle: sender.handle,
              latestSenderDescription: sender.description,
              mentionsAgent: true,
              nonMemberMention: true,
            }),
          );
        } catch {
          // The delivery row stays unreceived, so the daemon's recovery replays it.
        }
      }),
  );
}

/** Tells each newly notified person's open Activity page and nav dot to re-read. Best effort: the
 * next read shows the item anyway. */
export async function announceNotifiedPeople(
  realtime: Pick<ConversationRealtime, "activityChanged"> | undefined,
  workspaceId: string,
  userIds: readonly string[],
): Promise<void> {
  await Promise.all(
    userIds.map((userId) =>
      (realtime?.activityChanged?.({ workspaceId, userId }) ?? Promise.resolve()).catch(() => {}),
    ),
  );
}

/** An Agent notifies the targets of its own pending mentions: see `notifyMentionTargets`. */
export async function notifyAgentMentionTargets(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember" | "agentMessageDelivery">,
  workspaceId: string,
  agentId: string,
  resolutionIds: readonly string[],
  publisher: CentrifugoServerApi = createCentrifugoServerApi(),
): Promise<MentionActionResult[]> {
  const { results, deliveries, notifiedUserIds } = await notifyMentionTargets(
    db,
    workspaceId,
    { agentId },
    resolutionIds,
  );
  await publishNonMemberDeliveries(db, publisher, workspaceId, deliveries);
  await announceNotifiedPeople(
    new CentrifugoConversationRealtime(publisher),
    workspaceId,
    notifiedUserIds,
  );
  return results;
}
