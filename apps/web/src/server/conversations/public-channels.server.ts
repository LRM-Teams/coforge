import { lockConversation } from "./conversation-lock.server";
import { lockMemberPins, setConversationPin } from "./conversation-pins.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { CHANNEL_NAME_PATTERN } from "#src/features/conversations/conversation.schemas";
import { windowPageFlags } from "#src/lib/conversation-window";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { HUMAN_UNREAD_MESSAGE_SQL } from "./human-unread.server";
import {
  channelActorMemberWhere,
  deriveChannelAdminBasis,
  deriveChannelCapabilities,
  isChannelRole,
  resolveActorServerRole,
  resolveChannelAuthority,
} from "./channel-authority.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import { channelThreadRootWhere } from "#src/server/db/message-anchor.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  agentMessageSender,
  browserSenderHandle,
  browserSenderName,
} from "./sender-display.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { getMessageRequestIdempotency } from "./redis-message-request-idempotency.server";
import { encodeAgentDelivery } from "./agent-delivery.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { storeMessageBody } from "./message-references.server";
import { unresolvedMentionHandles } from "./unresolved-mentions.server";
import {
  claimMentionActions,
  pendingMentionActionsForMessage,
  recordPendingMentionActions,
  releaseMentionActions,
  type MentionActionResult,
} from "./pending-mention-actions.server";
import {
  BROWSER_MESSAGE_MENTIONS_SELECT,
  browserMessageMention,
  deliveryMentionsAgent,
  mentionAffinityScores,
  type BrowserMessageMentionRow,
} from "./mentions.server";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
  type MessageReactionRow,
} from "./message-reactions.server";
import { toggleUserMessageReaction } from "./user-message-reactions.server";
import {
  announceChannelUpdated,
  announceMemberChanged,
  type ConversationRealtime,
} from "./conversation-realtime.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { attachmentView } from "#src/server/attachments/attachment-view.server";
import type { ActionCardView } from "./action-cards.server";
import {
  agentVisibilityViewerForUser,
  canSeeAgent,
  visibleAgentWhere,
} from "#src/server/agents/agent-visibility.server";

/** A channel actor is either a human (by Workspace `userId`) or an Agent (by `agentId`); the
 * human/Web UI and the Agent CLI share `PublicChannels.members`/`addMembers` through this. */
export type ChannelActor = { userId: string } | { agentId: string };

/**
 * Soft-leaves one member's row (sets `leftAt`) if it is currently active; a no-op (returns
 * `false`) if the row is missing or already left. This is the one write both `leave` and
 * `removeMember` use, for both the human/Web UI (`PublicChannels.leave`/`removeMember`) and the
 * Agent CLI (`AgentChannelManagement.leave`/`removeMember`) — the soft-leave write
 * itself lives in exactly one place regardless of who is leaving/removing whom.
 */
export async function softLeaveMember(
  db: Pick<PrismaClient, "conversationMember">,
  conversationId: string,
  actor: ChannelActor,
): Promise<boolean> {
  const result = await db.conversationMember.updateMany({
    where: { conversationId, ...channelActorMemberWhere(actor), ...ACTIVE_MEMBER_WHERE },
    data: { leftAt: new Date() },
  });
  return result.count > 0;
}

/** Enroll Workspace humans and Agents. Membership alone never creates attention. */
/** Just the columns channelMessageView renders; the Agent row carries runtime JSON we never send. */
/** Prisma's unique-constraint failure: here, a channel name already taken in the Workspace. */
function isUniqueViolation(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "P2002";
}

const CHANNEL_MESSAGE_SELECT = {
  id: true,
  sequence: true,
  threadRootId: true,
  senderMemberId: true,
  body: true,
  createdAt: true,
  sender: {
    select: {
      agentId: true,
      agent: { select: { name: true, displayName: true, deletedAt: true, avatarObjectKey: true } },
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarObjectKey: true,
        },
      },
    },
  },
  attachments: {
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, objectKey: true },
    orderBy: { position: "asc" },
  },
  mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
  reactions: MESSAGE_REACTIONS_SELECT,
} satisfies Prisma.MessageSelect;

export type ChannelMessageRow = {
  id: string;
  sequence: number;
  threadRootId: string | null;
  senderMemberId: string | null;
  body: string;
  createdAt: Date;
  sender: {
    agentId: string | null;
    agent: {
      name: string;
      displayName: string | null;
      deletedAt: Date | null;
      avatarObjectKey: string | null;
    } | null;
    user: {
      id: string;
      username: string;
      displayName: string | null;
      avatarObjectKey: string | null;
    } | null;
  } | null;
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    objectKey: string;
  }[];
  /** Browser mention rows retain the immutable handle and resolve the current profile label. */
  mentions: BrowserMessageMentionRow[];
  reactions: MessageReactionRow[];
};

/** The browser-facing shape of one channel message, shared by page and update reads. The optional
 * `actionCard` field is attached by the caller (see `channels.functions.ts`,
 * `ActionCards.viewsFor`) in one batched lookup per page; this function never queries
 * `ActionCard` rows itself, to keep Prisma access for action cards in one place. Exported for a
 * pure unit test of this projection (no database needed). */
export function channelMessageView(message: ChannelMessageRow, workspaceId: string) {
  return {
    id: message.id,
    sequence: message.sequence,
    threadRootId: message.threadRootId ?? undefined,
    senderMemberId: message.senderMemberId,
    senderKind: !message.sender
      ? ("system" as const)
      : message.sender.agentId
        ? ("agent" as const)
        : ("user" as const),
    senderName: browserSenderName(message.sender),
    /** The handle behind that name: what you type to mention this sender, and what the
     * composer's recency ranking matches on. `undefined` for a server-authored message. */
    senderHandle: browserSenderHandle(message.sender),
    /** The Agent identity behind an agent-sent message, so the browser can open that Agent's
     * profile panel from the row (message-row.tsx). `undefined` for a user or system message. */
    senderAgentId: message.sender?.agentId ?? undefined,
    /** True when the sending Agent has since been deleted: the row renders its sender
     * greyed with a `DELETED` marker, and no longer opens that Agent's profile. */
    senderDeleted: Boolean(message.sender?.agent?.deletedAt),
    senderAvatarUrl: message.sender?.user
      ? workspaceUserAvatarUrl(
          workspaceId,
          message.sender.user.id,
          message.sender.user.avatarObjectKey,
        )
      : message.sender?.agentId && message.sender.agent
        ? agentAvatarUrl(workspaceId, message.sender.agentId, message.sender.agent.avatarObjectKey)
        : null,
    body: message.body,
    createdAt: message.createdAt,
    mentions: message.mentions.map(browserMessageMention),
    attachments: message.attachments.map((attachment) => attachmentView(attachment)),
    reactions: reactionSummaries(message.reactions),
    actionCard: undefined as ActionCardView | undefined,
  };
}

/** Nested creation keeps a new Workspace's `#general` inside the Workspace creation write, with
 * its creator already in it. */
export function generalChannelForCreator(userId: string) {
  return {
    create: { channelName: "general", members: { create: { userId } } },
  };
}

/**
 * Puts every Workspace human and every public, live Agent in `#general`, creating the channel if
 * the Workspace has none. `#general` is the Workspace-wide channel: nobody leaves it, so anyone
 * whose row was soft-left is back in. Called from the write points that add someone to the
 * Workspace (an accepted invitation, a new Agent); a new Workspace gets it through
 * `generalChannelForCreator`, and the 20260924040000 migration brought it back for older ones, so
 * reads never enroll.
 */
export async function enrollGeneralChannel(db: Prisma.TransactionClient, workspaceId: string) {
  await db.conversation.createMany({
    data: { workspaceId, channelName: "general" },
    skipDuplicates: true,
  });
  const general = await db.conversation.findUniqueOrThrow({
    where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
  });
  const members = await db.workspaceMembership.findMany({
    where: { workspaceId },
  });
  // New members start already-read: the badge counts only messages sent after enrollment,
  // never #general's pre-existing history (same rule as `join`/`addMembers`).
  const latest = await db.message.findFirst({
    where: { conversationId: general.id },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const readThroughSequence = latest?.sequence ?? 0;
  await db.conversationMember.createMany({
    data: members.map(({ userId }) => ({
      workspaceId,
      conversationId: general.id,
      userId,
      readThroughSequence,
    })),
    skipDuplicates: true,
  });
  // A private Agent is never an active channel member, #general included; making it public
  // enrolls it again (see `PrismaChangeAgentVisibilityStore`).
  const agents = await db.agent.findMany({
    where: { workspaceId, visibility: AGENT_VISIBILITY.PUBLIC, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
  await db.conversationMember.createMany({
    data: agents.map(({ id: agentId }) => ({
      workspaceId,
      conversationId: general.id,
      agentId,
      // An Agent joins #general muted, so ordinary chatter there does not wake every Agent in the
      // Workspace; a personal @mention still reaches it, and it may unmute.
      channelMuted: true,
    })),
    skipDuplicates: true,
  });
  // Nobody leaves #general: anyone whose row was soft-left is back in, a human read through its
  // history like anyone joining, an Agent (as on any late join) able to read that history.
  await db.conversationMember.updateMany({
    where: {
      conversationId: general.id,
      leftAt: { not: null },
      userId: { in: members.map(({ userId }) => userId) },
    },
    data: { leftAt: null, readThroughSequence },
  });
  await db.conversationMember.updateMany({
    where: {
      conversationId: general.id,
      leftAt: { not: null },
      agentId: { in: agents.map(({ id }) => id) },
    },
    data: { leftAt: null },
  });
  return general;
}

/** Puts one Agent that just became public back in `#general`, creating the channel if needed,
 * and returns the channel's id. The row is upserted so a first-time membership and a re-join
 * through a soft-left row are the same write; its read cursor and mute survive a re-join. */
export async function joinGeneralChannel(
  db: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
) {
  const general = await db.conversation.upsert({
    where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
    create: { workspaceId, channelName: "general" },
    update: {},
    select: { id: true },
  });
  await db.conversationMember.upsert({
    where: { conversationId_agentId: { conversationId: general.id, agentId } },
    // Muted on first joining, like every Agent in #general; a re-join keeps its own setting.
    create: { workspaceId, conversationId: general.id, agentId, channelMuted: true },
    update: { leftAt: null },
  });
  return general.id;
}

export async function getAgentChannel(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  if (!/^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target)) throw new AppError("INVALID_INPUT");
  const channel = await db.conversation.findFirst({
    where: {
      workspaceId,
      channelName: target.slice(1),
      ...VISIBLE_CONVERSATION_WHERE,
      members: { some: { agentId, agent: { workspaceId }, ...ACTIVE_MEMBER_WHERE } },
    },
  });
  if (!channel) throw new AppError("ACCESS_DENIED");
  return channel;
}

/**
 * Resolves a thread anchor (an eight-hex prefix or a full UUID) to its top-level root Message in
 * `conversationId`. Shared by `PublicChannels.threadRoot` and `ActionCards.prepare`
 * (`action-cards.server.ts`) so a channel thread target resolves identically everywhere.
 */
export async function resolveChannelThreadRoot(
  db: Pick<PrismaClient, "message">,
  conversationId: string,
  anchor: string,
) {
  const rows = await db.message.findMany({
    where: channelThreadRootWhere(conversationId, anchor),
    take: 2,
    select: { id: true },
  });
  if (rows.length > 1)
    throw new AgentMessageValidationError("ambiguous message prefix; use the full UUID");
  if (!rows[0])
    throw new AgentMessageValidationError("message anchor not found in this conversation");
  return rows[0];
}

/** Workspace-visible history with per-Agent notification preferences. */
export class PublicChannels {
  private readonly inboxPurge: Pick<AgentInboxPurgePublisher, "purge">;

  constructor(
    private readonly db: PrismaClient,
    private readonly idempotency?: MessageRequestIdempotency,
    private readonly publisher?: CentrifugoServerApi,
    private readonly notifications?: MessageNotifier,
    private readonly realtime?: ConversationRealtime,
    inboxPurge?: Pick<AgentInboxPurgePublisher, "purge">,
  ) {
    this.inboxPurge = inboxPurge ?? new AgentInboxPurgePublisher(db, publisher);
  }

  async setAgentMuted(workspaceId: string, agentId: string, target: string, muted: boolean) {
    const channel = await getAgentChannel(this.db, workspaceId, agentId, target);
    await this.db.$transaction(async (tx) => {
      // The same conversation lock orders preference changes against message creation.
      await lockConversation(tx, channel.id);
      await tx.conversationMember.update({
        where: {
          conversationId_agentId: { conversationId: channel.id, agentId },
        },
        data: { channelMuted: muted },
      });
    });
    return { muted };
  }

  async setAgentThreadFollowed(
    workspaceId: string,
    agentId: string,
    target: string,
    followed: boolean,
  ) {
    const [parentTarget, anchor] = target.split(":");
    if (!parentTarget || !anchor) throw new AppError("INVALID_INPUT");
    const channel = await getAgentChannel(this.db, workspaceId, agentId, parentTarget);
    const member = await this.db.conversationMember.findUniqueOrThrow({
      where: { conversationId_agentId: { conversationId: channel.id, agentId } },
      select: { id: true },
    });
    const root = await this.threadRoot(channel.id, anchor);
    await this.setThreadFollowed(member.id, workspaceId, channel.id, root.id, followed);
    return { followed };
  }

  async setUserMuted(workspaceId: string, userId: string, channelId: string, muted: boolean) {
    const channel = await this.channel(workspaceId, userId, channelId);
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, channel.id);
      const updated = await tx.conversationMember.updateMany({
        where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
        data: { channelMuted: muted },
      });
      if (updated.count !== 1) throw new AppError("ACCESS_DENIED");
    });
    return { muted };
  }

  /** Pins this conversation for this member only (see `setConversationPin` for the order).
   * Unpinning removes the row rather than zeroing it, so membership and pin state stay
   * independent of archive/leave (see `ConversationPin`). */
  async setUserPinned(
    workspaceId: string,
    userId: string,
    channelId: string,
    pinned: boolean,
    sortOrder?: number,
  ) {
    const channel = await this.channel(workspaceId, userId, channelId);
    await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, workspaceId, userId);
      await lockConversation(tx, channel.id);
      const member = await tx.conversationMember.findFirst({
        where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
        select: { id: true },
      });
      if (!member) throw new AppError("ACCESS_DENIED");
      await setConversationPin(
        tx,
        { workspaceId, userId, conversationId: channel.id, memberId: member.id },
        pinned,
        sortOrder,
      );
    });
    return { pinned };
  }

  /** Marks the conversation unread for this member, or clears the marker. Marking is anchored on
   * the newest top-level message, so the badge is at least one; a conversation with no messages
   * has nothing to mark. */
  async setUserUnread(workspaceId: string, userId: string, channelId: string, unread: boolean) {
    const channel = await this.channel(workspaceId, userId, channelId);
    let marker: number | null = null;
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, channel.id);
      if (unread) {
        const newest = await tx.message.findFirst({
          where: { conversationId: channel.id, threadRootId: null },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        marker = newest?.sequence ?? null;
      }
      const updated = await tx.conversationMember.updateMany({
        where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
        data: { unreadFromSequence: marker },
      });
      if (updated.count !== 1) throw new AppError("ACCESS_DENIED");
    });
    return { unread: marker !== null };
  }

  /** Closes (hides) the conversation for this member only, or brings it back. Distinct from
   * `archivedAt` (whole conversation) and `leftAt` (membership ended): nothing else changes and
   * the conversations stays readable. */
  async setUserHidden(workspaceId: string, userId: string, channelId: string, hidden: boolean) {
    const channel = await this.channel(workspaceId, userId, channelId);
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, channel.id);
      const updated = await tx.conversationMember.updateMany({
        where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
        data: { hiddenAt: hidden ? new Date() : null },
      });
      if (updated.count !== 1) throw new AppError("ACCESS_DENIED");
    });
    return { hidden };
  }

  async setUserThreadFollowed(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    followed: boolean,
  ) {
    await this.channel(workspaceId, userId, channelId);
    // A soft-left member (`leftAt` set) may no longer follow threads, matching `send`'s own
    // ACTIVE_MEMBER_WHERE check: leaving stops all delivery, not just ordinary channel posts.
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    const root = await this.threadRoot(channelId, rootMessageId);
    await this.setThreadFollowed(member.id, workspaceId, channelId, root.id, followed);
    return { followed };
  }

  /**
   * Agents currently following this channel Thread that the viewer may see.
   * Workspace members can read the list with the parent channel; only an active channel
   * member may later unfollow one of them.
   */
  async threadFollowingAgents(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
  ) {
    await this.channel(workspaceId, userId, channelId);
    const root = await this.threadRoot(channelId, rootMessageId);
    const viewer = await agentVisibilityViewerForUser(this.db, workspaceId, userId);
    const [actor, follows] = await Promise.all([
      this.db.conversationMember.findFirst({
        where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
        select: { id: true },
      }),
      this.db.threadFollow.findMany({
        where: {
          rootMessageId: root.id,
          conversationId: channelId,
          member: {
            agentId: { not: null },
            ...ACTIVE_MEMBER_WHERE,
            agent: {
              workspaceId,
              ...ACTIVE_AGENT_WHERE,
              ...visibleAgentWhere(viewer),
            },
          },
        },
        select: {
          member: {
            select: {
              agent: {
                select: { id: true, name: true, displayName: true, avatarObjectKey: true },
              },
            },
          },
        },
      }),
    ]);
    const agents = follows
      .flatMap((follow) => {
        const agent = follow.member.agent;
        if (!agent) return [];
        return [
          {
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName.trim() || agent.name,
            avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
          },
        ];
      })
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) || left.name.localeCompare(right.name),
      );
    return { canUnfollow: Boolean(actor), agents };
  }

  /**
   * A human channel member removes an Agent from this Thread's follow set. The Agent stays a
   * channel member; only subsequent ordinary thread notices stop. The viewer must be allowed
   * to see that Agent — a private Agent they cannot see is `NOT_FOUND`.
   */
  async unfollowAgentFromThread(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    agentId: string,
  ) {
    await this.channel(workspaceId, userId, channelId);
    const actor = await this.db.conversationMember.findFirst({
      where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true },
    });
    if (!actor) throw new AppError("ACCESS_DENIED");
    const root = await this.threadRoot(channelId, rootMessageId);
    const agentMember = await this.db.conversationMember.findFirst({
      where: {
        conversationId: channelId,
        agentId,
        ...ACTIVE_MEMBER_WHERE,
        agent: { workspaceId, ...ACTIVE_AGENT_WHERE },
      },
      select: {
        id: true,
        agent: { select: { visibility: true, ownerId: true } },
      },
    });
    const viewer = await agentVisibilityViewerForUser(this.db, workspaceId, userId);
    // Same answer for a missing Agent and a private Agent the viewer cannot see, so the
    // unfollow path cannot be used to probe private-Agent visibility.
    if (!agentMember?.agent || !canSeeAgent(viewer, agentMember.agent))
      throw new AppError("NOT_FOUND");
    await this.setThreadFollowed(agentMember.id, workspaceId, channelId, root.id, false);
    return { followed: false };
  }

  private async setThreadFollowed(
    memberId: string,
    workspaceId: string,
    conversationId: string,
    rootMessageId: string,
    followed: boolean,
  ) {
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      if (followed) {
        await tx.threadFollow.upsert({
          where: { memberId_rootMessageId: { memberId, rootMessageId } },
          create: { memberId, workspaceId, conversationId, rootMessageId },
          update: {},
        });
      } else {
        await tx.threadFollow.deleteMany({ where: { memberId, rootMessageId } });
      }
    });
  }

  private async threadRoot(conversationId: string, anchor: string) {
    return resolveChannelThreadRoot(this.db, conversationId, anchor);
  }

  private async authorize(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
  }

  /** The `ChannelActor` equivalent of `authorize`: a human must be a Workspace member, an Agent
   * must belong to the Workspace. */
  private async authorizeActor(workspaceId: string, actor: ChannelActor) {
    if ("userId" in actor) return this.authorize(workspaceId, actor.userId);
    const agent = await this.db.agent.findFirst({
      where: { id: actor.agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { id: true },
    });
    if (!agent) throw new AppError("ACCESS_DENIED");
  }

  /**
   * Every channel of the Workspace by id and current name, closed and archived ones included: the
   * authority a body's channel references are checked against before they link (see
   * `rehypeReferenceChips`), and what the composer's `#` list offers, with each channel's
   * description and archived flag for its row. Every channel is public, so every member can open
   * each one.
   */
  async names(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    const channels = await this.db.conversation.findMany({
      where: { workspaceId, channelName: { not: null }, ...VISIBLE_CONVERSATION_WHERE },
      select: { id: true, channelName: true, description: true, archivedAt: true },
    });
    return channels.map((channel) => ({
      id: channel.id,
      name: channel.channelName!,
      description: channel.description.trim(),
      archived: channel.archivedAt !== null,
    }));
  }

  async list(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    const [channels, unread] = await Promise.all([
      this.db.conversation.findMany({
        where: { workspaceId, channelName: { not: null }, ...VISIBLE_CONVERSATION_WHERE },
        orderBy: { channelName: "asc" },
        select: {
          id: true,
          channelName: true,
          archivedAt: true,
          members: {
            where: { userId, ...ACTIVE_MEMBER_WHERE },
            select: {
              id: true,
              channelMuted: true,
              // Slack-style unread cursor. Thread replies belong to their thread
              // target and never advance it, so they never count in the channel badge.
              readThroughSequence: true,
              // Forced unread (`mark as unread`) and per-member hide/close, plus this member's
              // pin order — the three member-level facts the conversation list renders (#121/#122).
              unreadFromSequence: true,
              hiddenAt: true,
              pins: { select: { sortOrder: true } },
            },
          },
        },
      }),
      // One query for every channel's unread: other-authored top-level messages past the
      // member's own read cursor, or from their mark-as-unread marker when that is lower.
      // System messages (no sender member) and the viewer's own messages are already-read by
      // definition; a soft-left membership has no badge. The count is a LATERAL per membership
      // with a single lower bound, so it is an index range on `messages(conversationId,
      // sequence)` covering only the unread tail; a plain join (or an OR of the two bounds)
      // lets the planner hash-join every message in the Workspace's channels instead.
      // `arrivedSinceClosed` counts the unread ones posted after the member closed the chat:
      // any of them brings a closed chat back to the list.
      this.db.$queryRaw<{ conversationId: string; unread: number; arrivedSinceClosed: number }[]>`
        SELECT cm."conversationId" AS "conversationId", unread."count" AS "unread",
          unread."arrivedSinceClosed" AS "arrivedSinceClosed"
        FROM "conversation_members" cm
        JOIN "conversations" c
          ON c."id" = cm."conversationId"
         AND c."workspaceId" = ${workspaceId}::uuid
         AND c."channelName" IS NOT NULL
         AND c."hiddenFromWorkspaceAt" IS NULL
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::int AS "count",
            COUNT(*) FILTER (WHERE m."createdAt" > cm."hiddenAt")::int AS "arrivedSinceClosed"
          FROM "messages" m
          WHERE m."conversationId" = cm."conversationId"
            AND m."threadRootId" IS NULL
            AND ${HUMAN_UNREAD_MESSAGE_SQL}
        ) unread
        WHERE cm."userId" = ${userId}::uuid
          AND cm."leftAt" IS NULL
          AND cm."workspaceId" = ${workspaceId}::uuid
      `,
    ]);
    const unreadByConversation = new Map(unread.map((row) => [row.conversationId, row.unread]));
    const reopenedByActivity = new Set(
      unread.filter((row) => row.arrivedSinceClosed > 0).map((row) => row.conversationId),
    );
    return channels
      .map((channel) => {
        const member = channel.members[0];
        // `.at(0)`, not `[0]`: the pinned row is genuinely optional and the type has to say so,
        // or the row's `pinSortOrder` narrows to `number` and cannot hold "not pinned".
        const pin = member?.pins.at(0);
        // A non-member (or soft-left viewer) sees no unread badge: the channel's history is
        // readable, but nothing new is "for them" until they join.
        return {
          id: channel.id,
          name: channel.channelName!,
          joined: Boolean(member),
          archived: channel.archivedAt !== null,
          muted: member?.channelMuted ?? false,
          unreadCount: member ? (unreadByConversation.get(channel.id) ?? 0) : 0,
          /// A closed chat disappears from this member's list only (see `hiddenAt` in the schema);
          /// the conversation itself stays readable, including through its own URL. A new message
          /// from someone else brings it back.
          hidden: member?.hiddenAt != null && !reopenedByActivity.has(channel.id),
          pinned: Boolean(member?.pins.length),
          pinSortOrder: pin ? pin.sortOrder : null,
        };
      })
      .filter(
        // A closed chat leaves the list unless it is pinned: Pinned keeps every pin.
        (channel) => !channel.hidden || channel.pinned,
      )
      .sort(
        // #general first, then by name. Pinned rows are ordered by `pinSortOrder` in the
        // sidebar's Pinned section, which merges them with pinned DMs.
        (a, b) => Number(b.name === "general") - Number(a.name === "general"),
      );
  }

  async create(
    workspaceId: string,
    userId: string,
    name: string,
    projectId?: string,
    description?: string,
  ) {
    await this.authorize(workspaceId, userId);
    if (!CHANNEL_NAME_PATTERN.test(name)) throw new AppError("INVALID_INPUT");
    // #general is the Workspace's own channel, created with the Workspace.
    if (name === "general") throw new AppError("CONFLICT");
    if (projectId) {
      const project = await this.db.project.findFirst({
        where: { id: projectId, workspaceId },
        select: { id: true },
      });
      if (!project) throw new AppError("INVALID_INPUT");
    }
    try {
      return await this.db.conversation.create({
        data: {
          workspaceId,
          channelName: name,
          ...(projectId ? { projectId } : {}),
          ...(description !== undefined ? { description } : {}),
          // The creator becomes the channel's first admin.
          members: { create: { userId, channelRole: "admin" } },
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("CONFLICT");
      throw error;
    }
  }

  /**
   * Promotes/demotes a channel member's stored `channelRole`. Human-only: there is
   * no Agent command for changing channel roles (Raft's rule, matched verbatim in
   * `agent-instructions.ts`). The actor needs `manage_roles` — Workspace owner/admin, or channel
   * admin of this specific channel — and `#general`'s roles are fixed (nobody can be its
   * channel admin), so any role change there is rejected outright.
   */
  async setChannelRole(
    workspaceId: string,
    actorUserId: string,
    channelId: string,
    member: ChannelActor,
    role: string,
  ) {
    const channel = await this.channel(workspaceId, actorUserId, channelId);
    if (channel.channelName === "general") throw new AppError("CONFLICT");
    if (!isChannelRole(role)) throw new AppError("INVALID_INPUT");
    const authority = await resolveChannelAuthority(
      this.db,
      workspaceId,
      { userId: actorUserId },
      channel,
    );
    if (!authority.capabilities.manage_roles) throw new AppError("ACCESS_DENIED");
    const updated = await this.db.conversationMember.updateMany({
      where: {
        conversationId: channelId,
        ...channelActorMemberWhere(member),
        ...ACTIVE_MEMBER_WHERE,
      },
      data: { channelRole: role },
    });
    if (updated.count !== 1) throw new AppError("NOT_FOUND");
    return { channelId, channelRole: role };
  }

  /**
   * The viewer's own recent @-mentions in one channel, newest first, for `mentionAffinityScores`.
   * Keyed by their member row (one per user per channel, kept after leaving) rather than a join
   * through `sender.userId`: that join could only walk every mention in the channel newest first
   * until it found the viewer's, while the member row reads their own messages from
   * `messages(senderMemberId, …)`. A reader with no member row has mentioned no one here.
   */
  private async viewerRecentMentions(channelId: string, userId: string) {
    const member = await this.db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: channelId, userId } },
      select: { id: true },
    });
    if (!member) return [];
    return this.db.messageMention.findMany({
      where: { conversationId: channelId, message: { senderMemberId: member.id } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { kind: true, actorId: true, createdAt: true },
    });
  }

  /**
   * Renames a channel or changes its description, for a human from the channel settings panel
   * and for an Agent's `channel update`. Needs the `update` capability (Workspace owner/admin or
   * this channel's admin). The name follows the creation rule and stays unique; `#general` keeps
   * its name but its description can change. An archived channel's info is frozen.
   */
  async updateInfo(
    workspaceId: string,
    actor: ChannelActor,
    channelId: string,
    patch: { name?: string; description?: string },
  ) {
    const channel = await this.findChannelById(workspaceId, channelId);
    const authority = await resolveChannelAuthority(this.db, workspaceId, actor, channel);
    if (!authority.capabilities.update) throw new AppError("ACCESS_DENIED");
    if (channel.archivedAt) throw new AppError("CONFLICT");
    const rename = patch.name !== undefined && patch.name !== channel.channelName;
    const redescribe = patch.description !== undefined && patch.description !== channel.description;
    if (!rename && !redescribe)
      return { id: channel.id, name: channel.channelName!, description: channel.description };
    if (rename) {
      if (channel.channelName === "general") throw new AppError("CONFLICT");
      if (!CHANNEL_NAME_PATTERN.test(patch.name!)) throw new AppError("INVALID_INPUT");
      if (patch.name === "general") throw new AppError("CONFLICT");
    }
    try {
      const updated = await this.db.conversation.update({
        where: { id: channel.id },
        data: {
          ...(rename ? { channelName: patch.name } : {}),
          ...(redescribe ? { description: patch.description } : {}),
        },
        select: { id: true, channelName: true, description: true },
      });
      await announceChannelUpdated(this.realtime, { workspaceId, conversationId: channel.id });
      return { id: updated.id, name: updated.channelName!, description: updated.description };
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("CONFLICT");
      throw error;
    }
  }

  /**
   * Whether `#general` is hidden from the whole Workspace, for the Workspace settings toggle.
   * Owner/admin only, like the change itself.
   */
  async generalHidden(workspaceId: string, userId: string): Promise<boolean> {
    const general = await this.generalForSettings(workspaceId, userId);
    return general.hiddenFromWorkspaceAt !== null;
  }

  /**
   * Hides `#general` from the whole Workspace, or restores it. A Workspace owner or admin does
   * this; while it is hidden nobody, themselves included, sees, reads or posts in it, and its
   * history is kept. Enrollment keeps running meanwhile, so a restore brings everyone back in.
   * Every open sidebar and page hears of the change; a call that changes nothing announces
   * nothing.
   */
  async setGeneralHidden(workspaceId: string, userId: string, hidden: boolean) {
    const general = await this.generalForSettings(workspaceId, userId);
    if ((general.hiddenFromWorkspaceAt !== null) === hidden) return { id: general.id, hidden };
    await this.db.conversation.update({
      where: { id: general.id },
      data: { hiddenFromWorkspaceAt: hidden ? new Date() : null },
    });
    await announceChannelUpdated(this.realtime, { workspaceId, conversationId: general.id });
    return { id: general.id, hidden };
  }

  /** `#general` as a Workspace setting sees it, hidden or not; only an owner or admin may. */
  private async generalForSettings(workspaceId: string, userId: string) {
    assertCanManageWorkspaceSettings(
      await resolveActorServerRole(this.db, workspaceId, { userId }),
    );
    const general = await this.db.conversation.findUnique({
      where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
      select: { id: true, hiddenFromWorkspaceAt: true },
    });
    if (!general) throw new AppError("NOT_FOUND");
    return general;
  }

  /**
   * Archives or unarchives a channel. Needs the `archive`/`unarchive` capability, which
   * `#general` never grants. Members keep reading an archived channel, but nobody posts in it or
   * joins it until it is unarchived.
   */
  async setArchived(
    workspaceId: string,
    actor: ChannelActor,
    channelId: string,
    archived: boolean,
  ) {
    const channel = await this.findChannelById(workspaceId, channelId);
    if (channel.channelName === "general") throw new AppError("CONFLICT");
    const authority = await resolveChannelAuthority(this.db, workspaceId, actor, channel);
    if (!authority.capabilities[archived ? "archive" : "unarchive"])
      throw new AppError("ACCESS_DENIED");
    // Already in the asked-for state: nothing to write or announce.
    if ((channel.archivedAt !== null) === archived) return { id: channel.id, archived };
    await this.db.conversation.update({
      where: { id: channel.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await announceChannelUpdated(this.realtime, { workspaceId, conversationId: channel.id });
    return { id: channel.id, archived };
  }

  private async findChannelById(workspaceId: string, channelId: string) {
    const channel = await this.db.conversation.findFirst({
      where: {
        id: channelId,
        workspaceId,
        channelName: { not: null },
        ...VISIBLE_CONVERSATION_WHERE,
      },
      select: { id: true, channelName: true, description: true, archivedAt: true },
    });
    if (!channel) throw new AppError("NOT_FOUND");
    return channel;
  }

  private async channel(workspaceId: string, userId: string, channelId: string) {
    await this.authorize(workspaceId, userId);
    const channel = await this.db.conversation.findFirst({
      where: {
        id: channelId,
        workspaceId,
        channelName: { not: null },
        ...VISIBLE_CONVERSATION_WHERE,
      },
      include: {
        project: {
          select: { id: true, name: true, slug: true, githubFullName: true, githubHtmlUrl: true },
        },
      },
    });
    if (!channel) throw new AppError("NOT_FOUND");
    return channel;
  }

  async join(workspaceId: string, userId: string, channelId: string) {
    const channel = await this.channel(workspaceId, userId, channelId);
    // Nobody joins an archived channel; its members keep reading it.
    if (channel.archivedAt) throw new AppError("CONFLICT");
    // Upsert (not createMany/skipDuplicates): a human previously removed from this channel by
    // an admin Agent has a row with `leftAt` set, which re-joining must clear rather than skip.
    // (Re-)joining starts already-read at the channel's current top-level end: the badge
    // counts what arrives *after* you joined, never the backlog that existed before.
    await this.db.$transaction(async (tx) => {
      await tx.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: channelId, userId } },
        create: { workspaceId, userId, conversationId: channelId },
        update: { leftAt: null },
      });
      const latest = await tx.message.findFirst({
        where: { conversationId: channelId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      await tx.conversationMember.updateMany({
        where: { conversationId: channelId, userId },
        data: { readThroughSequence: latest?.sequence ?? 0 },
      });
    });
    await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channelId] });
  }

  /**
   * Advances the human member's top-level read cursor. Monotone and clamped to the
   * conversation's current maximum sequence: a stale client cannot move the boundary backwards,
   * and an over-eager client cannot push it past the conversation (which would swallow future
   * messages into "already read").
   */
  async markRead(workspaceId: string, userId: string, channelId: string, throughSequence: number) {
    await this.channel(workspaceId, userId, channelId);
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
      throw new AppError("INVALID_INPUT");
    await this.db.$transaction(async (tx) => {
      const latest = await tx.message.findFirst({
        where: { conversationId: channelId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const boundary = Math.min(throughSequence, latest?.sequence ?? 0);
      if (boundary < 1) return;
      await tx.conversationMember.updateMany({
        where: {
          conversationId: channelId,
          userId,
          readThroughSequence: { lt: boundary },
          ...ACTIVE_MEMBER_WHERE,
        },
        data: { readThroughSequence: boundary },
      });
      // Reading past the forced `mark as unread` marker consumes it, so the badge does not come
      // back on the next render (see the marker's note in the schema).
      await tx.conversationMember.updateMany({
        where: {
          conversationId: channelId,
          userId,
          unreadFromSequence: { not: null, lte: boundary },
          ...ACTIVE_MEMBER_WHERE,
        },
        data: { unreadFromSequence: null },
      });
    });
  }

  /**
   * A human leaves a public channel they are an active member of themselves ("Leave a channel",
   * Slack: any member may leave a channel they belong to). Never `#general` (`CONFLICT`, Slack:
   * "It's not possible to leave the default #general channel"). Soft-left (`leftAt` set), not
   * deleted: the same row's mute preference and read boundary survive a later `join`, which clears
   * `leftAt` again.
   */
  async leave(workspaceId: string, userId: string, channelId: string) {
    const channel = await this.channel(workspaceId, userId, channelId);
    if (channel.channelName === "general") throw new AppError("CONFLICT");
    const wasMember = await softLeaveMember(this.db, channel.id, { userId });
    if (!wasMember) throw new AppError("ACCESS_DENIED");
    await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
    return { left: true };
  }

  /**
   * A channel admin (either basis) removes a human or Agent from a public channel — originally
   * Slack's "Workspace Owners and Admins can remove people from public channels", now
   * generalized to the `remove_member` capability so a channel admin via stored
   * `channelRole` may also remove members from a channel it administers, the same authority the
   * Agent CLI's `remove-member` already has. Never `#general` (`CONFLICT`, Slack:
   * "It's not possible to remove people from the #general … channel"). A plain member without
   * either admin basis is denied `ACCESS_DENIED` before any row is touched. Soft-left, same as
   * `leave`: messages, tasks and thread history stay; the row (mute preference, read boundary)
   * survives for a later re-add/rejoin.
   */
  async removeMember(
    workspaceId: string,
    actorUserId: string,
    channelId: string,
    target: ChannelActor,
  ) {
    const channel = await this.db.conversation.findFirst({
      where: {
        id: channelId,
        workspaceId,
        channelName: { not: null },
        ...VISIBLE_CONVERSATION_WHERE,
      },
      select: { id: true, channelName: true },
    });
    if (!channel) throw new AppError("NOT_FOUND");
    if (channel.channelName === "general") throw new AppError("CONFLICT");
    const authority = await resolveChannelAuthority(
      this.db,
      workspaceId,
      { userId: actorUserId },
      channel,
    );
    if (!authority.capabilities.remove_member) throw new AppError("ACCESS_DENIED");
    const wasMember = await softLeaveMember(this.db, channel.id, target);
    if (wasMember)
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
    if (wasMember && "agentId" in target)
      await this.inboxPurge.purge({
        workspaceId,
        agentId: target.agentId,
        conversationIds: [channel.id],
        reason: "member_removed",
      });
    return { removed: true, wasMember };
  }

  /**
   * Current members split into humans and Agents, plus candidates (Workspace
   * humans and Agents not yet members) and whether the actor may add members
   * (has an active ConversationMember row in this channel). Any Workspace
   * member or Agent may read this; channels are public within the Workspace.
   * Shared by the human "Members" dialog and the Agent CLI's `channel
   * members`/`add-member`; a soft-left row (`leftAt` set)
   * never counts as a current member.
   */
  async members(workspaceId: string, actor: ChannelActor, channelId: string) {
    await this.authorizeActor(workspaceId, actor);
    const channel = await this.db.conversation.findFirst({
      where: {
        id: channelId,
        workspaceId,
        channelName: { not: null },
        ...VISIBLE_CONVERSATION_WHERE,
      },
      select: { id: true, channelName: true, archivedAt: true },
    });
    if (!channel) throw new AppError("NOT_FOUND");
    const isGeneral = channel.channelName === "general";

    const [memberRows, workspaceUsers, workspaceAgents, actorServerRole] = await Promise.all([
      this.db.conversationMember.findMany({
        where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
        select: {
          channelRole: true,
          user: {
            select: { id: true, username: true, displayName: true, avatarObjectKey: true },
          },
          agent: {
            select: {
              id: true,
              name: true,
              displayName: true,
              description: true,
              role: true,
              computerId: true,
              avatarObjectKey: true,
            },
          },
        },
      }),
      this.db.user.findMany({
        where: { memberships: { some: { workspaceId } } },
        select: { id: true, username: true, displayName: true, avatarObjectKey: true },
        orderBy: [{ username: "asc" }, { id: "asc" }],
      }),
      // A private Agent can never join a channel, so it is never an add-candidate
      // either — unconditionally, the same "channels never contain a private Agent" invariant
      // `addMembers` enforces, not a viewer-scoped visibility read.
      this.db.agent.findMany({
        where: {
          workspaceId,
          weeklyReportAssistant: null,
          visibility: AGENT_VISIBILITY.PUBLIC,
          ...ACTIVE_AGENT_WHERE,
        },
        select: { id: true, name: true, displayName: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      // The actor's own server role (Workspace role for a human, Agent.role for an Agent),
      // independent of whether they are a member of *this* channel: an owner/admin who has
      // never joined a channel may still archive/remove-member/manage-roles on it.
      resolveActorServerRole(this.db, workspaceId, actor),
    ]);

    const memberUserIds = new Set(memberRows.flatMap((row) => (row.user ? [row.user.id] : [])));
    const memberAgentIds = new Set(memberRows.flatMap((row) => (row.agent ? [row.agent.id] : [])));
    const humanRoles = memberUserIds.size
      ? await this.db.workspaceMembership.findMany({
          where: { workspaceId, userId: { in: [...memberUserIds] } },
          select: { userId: true, role: true },
        })
      : [];
    const roleByUserId = new Map(humanRoles.map((row) => [row.userId, row.role]));

    const actorRow = memberRows.find((row) =>
      "userId" in actor ? row.user?.id === actor.userId : row.agent?.id === actor.agentId,
    );
    const isActiveMember = Boolean(actorRow);
    const actorAdminBasis = deriveChannelAdminBasis(actorServerRole, actorRow?.channelRole);
    const capabilities = deriveChannelCapabilities({
      isHuman: "userId" in actor,
      isActiveMember,
      isGeneral,
      adminBasis: actorAdminBasis,
    });

    return {
      // Nobody adds members to an archived channel.
      canAddMembers: isActiveMember && channel.archivedAt === null,
      // The actor's own channel role/admin basis/capabilities on this channel.
      channelRole: actorRow?.channelRole,
      channelAdminBasis: actorAdminBasis,
      channelCapabilities: capabilities,
      // Alias of the capability matrix above for `ChannelMembersDialog`'s Remove action: a
      // channel admin via `channelRole` (not just a Workspace owner/admin) may also remove
      // members from a channel it administers.
      canRemoveMembers: capabilities.remove_member,
      humans: memberRows
        .filter((row) => row.user)
        .map((row) => {
          const serverRole = roleByUserId.get(row.user!.id) ?? "member";
          return {
            id: row.user!.id,
            username: row.user!.username,
            displayName: row.user!.displayName?.trim() || row.user!.username,
            avatarUrl: workspaceUserAvatarUrl(workspaceId, row.user!.id, row.user!.avatarObjectKey),
            serverRole,
            channelRole: row.channelRole,
            channelAdminBasis: deriveChannelAdminBasis(serverRole, row.channelRole),
          };
        }),
      agents: memberRows
        .filter((row) => row.agent)
        .map((row) => ({
          id: row.agent!.id,
          name: row.agent!.name,
          displayName: row.agent!.displayName?.trim() || row.agent!.name,
          description: row.agent!.description,
          avatarUrl: agentAvatarUrl(workspaceId, row.agent!.id, row.agent!.avatarObjectKey),
          serverRole: row.agent!.role,
          channelRole: row.channelRole,
          channelAdminBasis: deriveChannelAdminBasis(row.agent!.role, row.channelRole),
          computerId: row.agent!.computerId,
        })),
      candidates: {
        humans: workspaceUsers
          .filter((user) => !memberUserIds.has(user.id))
          .map((user) => ({
            id: user.id,
            username: user.username,
            displayName: user.displayName?.trim() || user.username,
            avatarUrl: workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey),
          })),
        agents: workspaceAgents
          .filter((agent) => !memberAgentIds.has(agent.id))
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName?.trim() || agent.name,
          })),
      },
    };
  }

  /**
   * A channel member adds Workspace humans and/or Agents as channel members
   * (Slack: you add people to channels you belong to). Membership alone never
   * creates attention: delivery eligibility is computed at message time.
   * Adding someone whose row exists but is soft-left (`leftAt` set) clears
   * `leftAt` rather than being a no-op, and keeps their prior read boundary
   * and mute preference (upsert, not `createMany`/`skipDuplicates`).
   */
  async addMembers(
    workspaceId: string,
    actor: ChannelActor,
    channelId: string,
    input: { userIds: string[]; agentIds: string[] },
  ) {
    await this.authorizeActor(workspaceId, actor);
    const channel = await this.db.conversation.findFirst({
      where: {
        id: channelId,
        workspaceId,
        channelName: { not: null },
        ...VISIBLE_CONVERSATION_WHERE,
      },
      select: { id: true, archivedAt: true },
    });
    if (!channel) throw new AppError("NOT_FOUND");
    // Nobody joins an archived channel, including by being added.
    if (channel.archivedAt) throw new AppError("CONFLICT");

    const actorMembership = await this.db.conversationMember.findFirst({
      where: {
        conversationId: channelId,
        ...channelActorMemberWhere(actor),
        ...ACTIVE_MEMBER_WHERE,
      },
      select: { id: true },
    });
    if (!actorMembership) throw new AppError("ACCESS_DENIED");

    const userIds = [...new Set(input.userIds)];
    const agentIds = [...new Set(input.agentIds)];
    if (userIds.length) {
      const validUsers = await this.db.workspaceMembership.count({
        where: { workspaceId, userId: { in: userIds } },
      });
      if (validUsers !== userIds.length) throw new AppError("INVALID_INPUT");
    }
    if (agentIds.length) {
      const targetAgents = await this.db.agent.findMany({
        where: { workspaceId, id: { in: agentIds }, ...ACTIVE_AGENT_WHERE },
        select: { id: true, visibility: true },
      });
      if (targetAgents.length !== agentIds.length) throw new AppError("INVALID_INPUT");
      // A private Agent is never an active channel member — reject the whole add
      // rather than silently drop it, with a stable code + explanation for the caller.
      if (targetAgents.some((agent) => agent.visibility !== AGENT_VISIBILITY.PUBLIC))
        throw new AppError("INVALID_INPUT", { errorId: "agent-private" });
    }

    // Read who was already an active member before writing, so a caller (the Agent CLI) can
    // report "already in #channel" instead of a bare success for a no-op add.
    const alreadyActive = await this.db.conversationMember.findMany({
      where: {
        conversationId: channelId,
        ...ACTIVE_MEMBER_WHERE,
        OR: [
          ...(userIds.length ? [{ userId: { in: userIds } }] : []),
          ...(agentIds.length ? [{ agentId: { in: agentIds } }] : []),
        ],
      },
      select: { userId: true, agentId: true },
    });
    const alreadyMemberUserIds = alreadyActive.flatMap((row) => (row.userId ? [row.userId] : []));
    const alreadyMemberAgentIds = alreadyActive.flatMap((row) =>
      row.agentId ? [row.agentId] : [],
    );

    // (Re-)added members start already-read at the channel's current end: the badge counts
    // what arrives after the add, never the backlog that existed before (mirrors `join`). An
    // already-active member keeps the read position they had — re-adding is a no-op.
    const cursor = await this.db.message.findFirst({
      where: { conversationId: channelId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const readThroughSequence = cursor?.sequence ?? 0;
    const alreadyActiveUserIds = new Set(alreadyMemberUserIds);
    await Promise.all([
      ...userIds.map((userId) =>
        alreadyActiveUserIds.has(userId)
          ? Promise.resolve()
          : this.db.conversationMember.upsert({
              where: { conversationId_userId: { conversationId: channelId, userId } },
              create: {
                workspaceId,
                conversationId: channelId,
                userId,
                readThroughSequence,
              },
              update: { leftAt: null, readThroughSequence },
            }),
      ),
      ...agentIds.map((agentId) =>
        this.db.conversationMember.upsert({
          where: { conversationId_agentId: { conversationId: channelId, agentId } },
          create: { workspaceId, conversationId: channelId, agentId },
          update: { leftAt: null },
        }),
      ),
    ]);
    const added =
      userIds.length - alreadyMemberUserIds.length + agentIds.length - alreadyMemberAgentIds.length;
    if (added > 0)
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channelId] });

    const result = await this.members(workspaceId, actor, channelId);
    return { ...result, alreadyMemberUserIds, alreadyMemberAgentIds };
  }

  /**
   * The sender acts on mentions of their messages that did not reach their target: `add` makes
   * each target a member of the channel it was mentioned in, under the sender's own authority to
   * add members. Results come back in request order, one per distinct resolution id.
   */
  async executeMentionActions(
    workspaceId: string,
    userId: string,
    action: "add",
    resolutionIds: readonly string[],
  ): Promise<MentionActionResult[]> {
    await this.authorize(workspaceId, userId);
    const { refused, claimed } = await claimMentionActions(
      this.db,
      workspaceId,
      userId,
      action,
      resolutionIds,
    );
    const results = new Map(refused.map((result) => [result.resolutionId, result]));
    const byChannel = new Map<string, typeof claimed>();
    for (const claim of claimed)
      byChannel.set(claim.conversationId, [...(byChannel.get(claim.conversationId) ?? []), claim]);
    for (const [channelId, claims] of byChannel) {
      try {
        await this.addMembers(workspaceId, { userId }, channelId, {
          userIds: claims.flatMap((claim) => (claim.targetType === "user" ? [claim.targetId] : [])),
          agentIds: claims.flatMap((claim) =>
            claim.targetType === "agent" ? [claim.targetId] : [],
          ),
        });
        for (const claim of claims)
          results.set(claim.resolutionId, {
            resolutionId: claim.resolutionId,
            status: "delivered",
            targetType: claim.targetType,
            targetId: claim.targetId,
          });
      } catch (error) {
        await releaseMentionActions(this.db, claims);
        if (!isAppError(error)) throw error;
        for (const claim of claims)
          results.set(claim.resolutionId, {
            resolutionId: claim.resolutionId,
            status: "no_permission",
            reason: "could_not_apply",
            targetType: claim.targetType,
            targetId: claim.targetId,
          });
      }
    }
    return [...new Set(resolutionIds)].map((id) => results.get(id)!);
  }

  async open(
    workspaceId: string,
    userId: string,
    channelId: string,
    page: { beforeSequence?: number; afterSequence?: number; limit?: number } = {},
  ) {
    const channel = await this.channel(workspaceId, userId, channelId);
    const limit = Math.min(page.limit ?? 50, 100);
    // A forward fetch reads towards the live end from the newest sequence the retained window still
    // holds; a backward fetch reads history upwards. Neither is the initial (uncursored) load,
    // which lands on the newest page (see `lib/conversation-window.ts`).
    const forward = page.afterSequence !== undefined;
    const [member, messages, mentionRows, viewerRecentMentions, authority] = await Promise.all([
      // Filtered through ACTIVE_MEMBER_WHERE (not findUnique on the raw row): a human who left or
      // was removed must see the read-only preview (`senderMemberId` empty) like anyone who never
      // joined, not their old member state. The row itself survives untouched for a later rejoin.
      this.db.conversationMember.findFirst({
        where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
        include: {
          threadReads: true,
          threadFollows: true,
          user: { select: { username: true } },
          pins: { select: { sortOrder: true } },
        },
      }),
      this.db.message.findMany({
        where: {
          conversationId: channelId,
          threadRootId: null,
          sequence: forward
            ? { gt: page.afterSequence }
            : page.beforeSequence
              ? { lt: page.beforeSequence }
              : undefined,
        },
        // Both directions take `limit + 1` rows to learn whether one more remains; the page is
        // re-sorted by sequence below, so only the overflow row's presence matters.
        orderBy: { sequence: forward ? ("asc" as const) : ("desc" as const) },
        take: limit + 1,
        select: {
          ...CHANNEL_MESSAGE_SELECT,
          replies: { orderBy: { sequence: "asc" }, select: CHANNEL_MESSAGE_SELECT },
        },
      }),
      // The composer's @-completion source: every other active member's public profile.
      this.db.conversationMember.findMany({
        where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
        select: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              description: true,
              avatarObjectKey: true,
            },
          },
          agent: {
            select: {
              id: true,
              name: true,
              displayName: true,
              description: true,
              avatarObjectKey: true,
            },
          },
        },
      }),
      // Scores each completion candidate by the viewer's own recent mentions here.
      this.viewerRecentMentions(channelId, userId),
      // What the settings panel offers this viewer: edit, archive, leave.
      resolveChannelAuthority(this.db, workspaceId, { userId }, channel),
    ]);
    const mentionScores = mentionAffinityScores(viewerRecentMentions);
    const overflow = messages.length > limit;
    const { hasOlder, hasNewer } = windowPageFlags(
      forward ? "forward" : page.beforeSequence ? "backward" : "initial",
      overflow,
    );
    // The overflow row is always the newest of the fetched rows, so dropping the tail of the
    // ordered list keeps the reader's side of the window and drops the row that only proved there
    // was more.
    const fetched = messages.slice(0, limit);
    const pageMessages = (forward ? fetched : fetched.reverse())
      .flatMap((message) => [message, ...message.replies])
      .sort((left, right) => left.sequence - right.sequence);
    return {
      conversationId: channel.id,
      name: channel.channelName!,
      description: channel.description,
      archived: channel.archivedAt !== null,
      project: channel.project ?? undefined,
      senderMemberId: member?.id ?? "",
      viewerHandle: member?.user?.username,
      muted: member?.channelMuted ?? false,
      pinned: Boolean(member?.pins.length),
      channelCapabilities: authority.capabilities,
      // The viewer's conversation-level read cursor over top-level messages:
      // the client positions the initial view at the first unread message and draws the
      // divider there. Undefined for a non-member (nothing is "unread for them").
      readThroughSequence: member?.readThroughSequence,
      threadReadThrough: Object.fromEntries(
        (member?.threadReads ?? []).map((read) => [read.rootMessageId, read.readThroughSequence]),
      ),
      followedThreadRootIds: (member?.threadFollows ?? []).map((follow) => follow.rootMessageId),
      // Every active member, the viewer included: this list is what *resolves* a stored mention
      // token, and a mention of the viewer is the most common one to render — leaving their row
      // out leaked the raw `<@human:uuid>` token in their own view. The composer's rule that you
      // never mention yourself is applied where it belongs, in the composer's candidate list.
      mentionables: mentionRows
        .map((row) =>
          row.user
            ? {
                kind: "user" as const,
                id: row.user.id,
                handle: row.user.username,
                label: row.user.displayName?.trim() || row.user.username,
                description: row.user.description.trim(),
                avatarUrl: workspaceUserAvatarUrl(
                  workspaceId,
                  row.user.id,
                  row.user.avatarObjectKey,
                ),
                mentionScore: mentionScores.get(`user:${row.user.id}`) ?? 0,
              }
            : {
                kind: "agent" as const,
                id: row.agent!.id,
                handle: row.agent!.name,
                label: row.agent!.displayName?.trim() || row.agent!.name,
                description: row.agent!.description.trim(),
                avatarUrl: agentAvatarUrl(workspaceId, row.agent!.id, row.agent!.avatarObjectKey),
                mentionScore: mentionScores.get(`agent:${row.agent!.id}`) ?? 0,
              },
        )
        .sort((left, right) => left.handle.localeCompare(right.handle)),
      hasOlder,
      hasNewer,
      messages: pageMessages.map((message) => channelMessageView(message, workspaceId)),
    };
  }

  /**
   * The composer's @-completion directory for one channel, fetched on demand: every active
   * member (the viewer included, per #574 — this list also resolves stored mention tokens)
   * scored by the viewer's recent mentions. The conversation payload carries it once per
   * load, so members who join while the page is open would otherwise only appear after a
   * full refresh; the composer refetches this while the conversation stays open.
   */
  async mentionDirectory(workspaceId: string, userId: string, channelId: string) {
    await this.channel(workspaceId, userId, channelId);
    const [mentionRows, viewerRecentMentions] = await Promise.all([
      this.db.conversationMember.findMany({
        where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
        select: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              description: true,
              avatarObjectKey: true,
            },
          },
          agent: {
            select: {
              id: true,
              name: true,
              displayName: true,
              description: true,
              avatarObjectKey: true,
            },
          },
        },
      }),
      this.viewerRecentMentions(channelId, userId),
    ]);
    const mentionScores = mentionAffinityScores(viewerRecentMentions);
    return mentionRows
      .map((row) =>
        row.user
          ? {
              kind: "user" as const,
              id: row.user.id,
              handle: row.user.username,
              label: row.user.displayName?.trim() || row.user.username,
              description: row.user.description.trim(),
              avatarUrl: workspaceUserAvatarUrl(workspaceId, row.user.id, row.user.avatarObjectKey),
              mentionScore: mentionScores.get(`user:${row.user.id}`) ?? 0,
            }
          : {
              kind: "agent" as const,
              id: row.agent!.id,
              handle: row.agent!.name,
              label: row.agent!.displayName?.trim() || row.agent!.name,
              description: row.agent!.description.trim(),
              avatarUrl: agentAvatarUrl(workspaceId, row.agent!.id, row.agent!.avatarObjectKey),
              mentionScore: mentionScores.get(`agent:${row.agent!.id}`) ?? 0,
            },
      )
      .sort((left, right) => left.handle.localeCompare(right.handle));
  }

  async updates(workspaceId: string, userId: string, channelId: string, afterSequence: number) {
    await this.channel(workspaceId, userId, channelId);
    const messages = await this.db.message.findMany({
      where: {
        conversationId: channelId,
        sequence: { gt: afterSequence },
      },
      orderBy: { sequence: "asc" },
      take: 100,
      select: CHANNEL_MESSAGE_SELECT,
    });
    return messages.map((message) => channelMessageView(message, workspaceId));
  }

  async send(input: {
    workspaceId: string;
    userId: string;
    channelId: string;
    requestId: string;
    body: string;
    attachmentIds?: string[];
    threadRootId?: string;
  }) {
    const { workspaceId, userId, channelId, requestId, attachmentIds, threadRootId } = input;
    const channel = await this.channel(workspaceId, userId, channelId);
    if (channel.archivedAt) throw new AppError("CONFLICT");
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    const body = input.body.trim();
    if (!body || body.length > 8_000) throw new AppError("INVALID_INPUT");
    let created = false;
    const saved = await (this.idempotency ?? getMessageRequestIdempotency()).execute(
      { workspaceId, senderKind: "user", senderId: userId, requestId },
      () =>
        this.db.$transaction(async (tx) => {
          await lockConversation(tx, channelId);
          const root = threadRootId
            ? await tx.message.findFirst({
                where: { id: threadRootId, conversationId: channelId },
                select: { id: true, threadRootId: true, senderMemberId: true },
              })
            : undefined;
          if (threadRootId && !root)
            throw new AgentMessageValidationError("message anchor not found in this conversation");
          if (root?.threadRootId)
            throw new AgentMessageValidationError("thread root must be a top-level message");
          const latest = await tx.message.findFirst({
            where: { conversationId: channelId },
            orderBy: { sequence: "desc" },
          });
          // Validated before the message exists, then linked (messageId + position) once it does.
          const requestedAttachmentIds = attachmentIds ?? [];
          const availableAttachments = requestedAttachmentIds.length
            ? await tx.attachment.findMany({
                where: {
                  id: { in: [...new Set(requestedAttachmentIds)] },
                  conversationId: channelId,
                  workspaceId,
                  uploaderId: userId,
                  messageId: null,
                },
                select: { id: true },
              })
            : [];
          const availableAttachmentIds = new Set(
            availableAttachments.map((attachment) => attachment.id),
          );
          const attachmentRowIds = requestedAttachmentIds.map((attachmentId) => {
            if (!availableAttachmentIds.has(attachmentId)) throw new AppError("ACCESS_DENIED");
            return attachmentId;
          });
          // Resolve @mentions against the channel's active members once. The stored body keeps
          // each resolved mention as an embedded-UUID token (`<@human:…>`/`<@agent:…>`,
          // Slack-style) and every resolved mention becomes a MessageMention row in the same
          // transaction, so renders and delivery never re-parse prose. Task references
          // (`task #68` → `<@task:68>`), channel references (`#product` →
          // `<@channel:uuid:product>`) and thread references (`#product:abcdef12` →
          // `<@thread:uuid:uuid:product>`) are resolved in the same pass: the server decides what
          // names a real task, channel or thread, and anything else stays ordinary text.
          const activeMembers = await tx.conversationMember.findMany({
            where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
            select: {
              id: true,
              userId: true,
              agentId: true,
              user: { select: { username: true } },
              agent: { select: { name: true } },
            },
          });
          const stored = await storeMessageBody(
            tx,
            { workspaceId, conversationId: channelId },
            body,
            {
              targets: activeMembers.map((channelMember) =>
                channelMember.userId
                  ? {
                      key: channelMember.id,
                      type: "user" as const,
                      id: channelMember.userId,
                      handle: channelMember.user!.username,
                    }
                  : {
                      key: channelMember.id,
                      type: "agent" as const,
                      id: channelMember.agentId!,
                      handle: channelMember.agent!.name,
                    },
              ),
            },
          );
          if (root) {
            // Everyone who takes part in a thread is a follower: whoever replies, everyone the
            // reply @mentions, and — the first time the thread gets a reply — the author of the
            // message being replied to. Without that last one, a reply under someone's own
            // message never enrolls them, and since a thread reply is not a parent-channel post,
            // nothing would ever notify them of the discussion started under their message.
            const participants = [member.id, ...stored.mentions.map((mention) => mention.key)];
            // Only while the thread is brand new: an explicit `thread unfollow` is a decision, and
            // a later reply must not silently enroll the root author back into the thread.
            const existingFollower = await tx.threadFollow.findFirst({
              where: { rootMessageId: root.id },
              select: { memberId: true },
            });
            if (root.senderMemberId && !existingFollower) participants.push(root.senderMemberId);
            await tx.threadFollow.createMany({
              data: participants.map((memberId) => ({
                memberId,
                rootMessageId: root.id,
                conversationId: channelId,
                workspaceId,
              })),
              skipDuplicates: true,
            });
          }
          // Directed delivery: a message that @mentions at least one Agent wakes exactly those
          // Agents (a mention pierces mute), and no others. Mentioning only humans never narrows
          // Agent delivery.
          //
          // Without an Agent mention the audience depends on what the message *is*: a top-level
          // message belongs to the channel, so every unmuted Agent member receives it; a reply
          // belongs to its thread, so it reaches the thread's **followers** — the set the block
          // above enrolls: whoever replies, everyone the reply mentions, and the thread's root
          // author. Reaching the whole channel from inside a thread meant a human replying to one
          // Agent woke every unmuted Agent in it (reported 2026-09-21). A root author who explicitly
          // unfollowed stays out, which is why this reads follows and not authorship.
          const mentionedAgentIds = stored.mentions
            .filter((mention) => mention.type === "agent")
            .map((mention) => mention.id);
          const recipients =
            mentionedAgentIds.length > 0
              ? mentionedAgentIds.map((agentId) => ({ agentId }))
              : await tx.conversationMember.findMany({
                  where: {
                    conversationId: channelId,
                    agentId: { not: null },
                    agent: { workspaceId },
                    ...ACTIVE_MEMBER_WHERE,
                    ...(root
                      ? { threadFollows: { some: { rootMessageId: root.id } } }
                      : { channelMuted: false }),
                  },
                  select: { agentId: true },
                });
          const sequence = (latest?.sequence ?? 0) + 1;
          const message = await tx.message.create({
            data: {
              workspaceId,
              conversationId: channelId,
              senderMemberId: member.id,
              threadRootId: root?.id,
              body: stored.body,
              sequence,
              mentions: stored.mentions.length
                ? {
                    create: stored.mentions.map((mention) => ({
                      memberId: mention.key,
                      workspaceId,
                      kind: mention.type,
                      actorId: mention.id,
                      handle: mention.handle,
                    })),
                  }
                : undefined,
              deliveries: {
                create: recipients.map(({ agentId }) => ({
                  workspaceId,
                  conversationId: channelId,
                  agentId: agentId!,
                  sequence,
                })),
              },
            },
          });
          // A mention of someone outside the channel reached nobody; the sender may still act on it.
          await recordPendingMentionActions(tx, {
            id: message.id,
            workspaceId,
            conversationId: channelId,
            senderMemberId: member.id,
            body: stored.body,
            createdAt: message.createdAt,
          });
          await Promise.all(
            attachmentRowIds.map((id, position) =>
              tx.attachment.update({
                where: { id },
                data: { messageId: message.id, position },
              }),
            ),
          );
          created = true;
          return {
            ...message,
            target: `#${channel.channelName}${root ? `:${root.id}` : ""}`,
            // Never read back: only `saved.id` is used below (the post-transaction reload via
            // CHANNEL_MESSAGE_SELECT is the real attachments source). Present only to satisfy
            // the shared idempotency-cache value's "always present" contract.
            attachments: [] as {
              id: string;
              fileName: string;
              contentType: string;
              sizeBytes: number;
            }[],
          };
        }),
    );
    // Reuse persisted delivery identities on retries; never recompute recipients after mute changes.
    const message = await this.db.message.findFirstOrThrow({
      where: {
        id: saved.id,
        conversationId: channelId,
        senderMemberId: member.id,
      },
      select: {
        ...CHANNEL_MESSAGE_SELECT,
        // Wider than CHANNEL_MESSAGE_SELECT's sender: this reload alone feeds
        // `agentMessageSender` below, which needs the sender's description too.
        sender: {
          select: {
            agentId: true,
            agent: {
              select: { name: true, displayName: true, deletedAt: true, description: true },
            },
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarObjectKey: true,
                description: true,
              },
            },
          },
        },
        deliveries: {
          select: { deliveryId: true, agentId: true, agent: { select: { computerId: true } } },
        },
      },
    });
    if (created) await this.notifications?.notifyMessage(message.id);
    if (this.realtime) {
      try {
        await this.realtime.messageAvailable({
          conversationId: channelId,
          messageId: message.id,
          sequence: message.sequence,
          workspaceId,
          threadRootId: message.threadRootId ?? undefined,
          requestId,
        });
      } catch {
        // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
      }
    }
    // Every Agent's push goes out at once; a failure still rejects the send. The encoder reads the
    // stored tokens back as text for the Agent.
    const publisher = this.publisher ?? createCentrifugoServerApi();
    // Routed through the shared projection rather than two non-null assertions on
    // `sender.user`, which broke for an Agent-authored channel delivery.
    const sender = agentMessageSender(message.sender);
    await Promise.all(
      message.deliveries
        .filter((delivery) => delivery.agent.computerId)
        .map((delivery) =>
          publisher.publish(
            daemonControlChannel(input.workspaceId, delivery.agent.computerId!),
            encodeAgentDelivery({
              requestId,
              workspaceId,
              conversationId: channelId,
              agentId: delivery.agentId,
              messageId: message.id,
              deliveryId: delivery.deliveryId,
              sequence: message.sequence,
              body: message.body,
              mentions: message.mentions,
              target: `#${channel.channelName}${message.threadRootId ? `:${message.threadRootId}` : ""}`,
              latestSenderKind: sender.kind,
              latestSenderHandle: sender.handle,
              latestSenderDescription: sender.description,
              mentionsAgent: deliveryMentionsAgent(message.mentions, delivery.agentId),
            }),
          ),
        ),
    );
    // Read from the stored body, so an idempotent replay reads the same `@handle`s.
    const unresolved = await unresolvedMentionHandles(
      this.db,
      workspaceId,
      { userId },
      message.body,
    );
    const pendingMentionActions = await pendingMentionActionsForMessage(
      this.db,
      {
        id: message.id,
        workspaceId,
        conversationId: channelId,
        senderMemberId: member.id,
        body: message.body,
      },
      { archived: channel.archivedAt !== null, name: channel.channelName! },
    );
    return { ...message, unresolvedMentionHandles: unresolved, pendingMentionActions };
  }

  /**
   * The browser's own emoji reaction on a channel message. Same visibility scope as the
   * other per-message writes here; the shared toggle additionally requires the caller's
   * active membership, so a reader who never joined cannot react.
   */
  async toggleUserReaction(
    workspaceId: string,
    userId: string,
    channelId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ) {
    await this.channel(workspaceId, userId, channelId);
    return toggleUserMessageReaction(this.db, {
      workspaceId,
      conversationId: channelId,
      userId,
      messageId,
      emoji,
      active,
    });
  }

  async markThreadReadForUser(
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    throughSequence: number,
  ) {
    await this.channel(workspaceId, userId, channelId);
    const root = await this.db.message.findFirst({
      where: { id: rootMessageId, conversationId: channelId, threadRootId: null },
      select: { id: true },
    });
    if (!root)
      throw new AgentMessageValidationError("message anchor not found in this conversation");
    const [member, latest] = await Promise.all([
      this.db.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: channelId, userId } },
        select: { id: true },
      }),
      this.db.message.findFirst({
        where: {
          conversationId: channelId,
          threadRootId: root.id,
          sequence: { lte: throughSequence },
        },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      }),
    ]);
    if (!member || !latest) return;
    await this.db.$executeRaw`INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
      VALUES (${member.id}::uuid, ${channelId}::uuid, ${workspaceId}::uuid, ${root.id}::uuid, ${latest.sequence})
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
        GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`;
  }
}
