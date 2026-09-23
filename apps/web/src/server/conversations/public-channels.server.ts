import { lockConversation } from "./conversation-lock.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { windowPageFlags } from "#src/lib/conversation-window";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import {
  channelActorMemberWhere,
  deriveChannelAdminBasis,
  deriveChannelCapabilities,
  isChannelRole,
  resolveActorServerRole,
  resolveChannelAuthority,
} from "./channel-authority.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  agentMessageSender,
  browserSenderHandle,
  browserSenderName,
} from "./sender-display.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { getMessageRequestIdempotency } from "./redis-message-request-idempotency.server";
import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import {
  normalizeMentionBody,
  resolveTaskReferences,
  taskReferenceNumbers,
} from "@lrm/coforge-sdk/internal";
import {
  agentReadableBody,
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
import type { ConversationRealtime } from "./conversation-realtime.server";
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

/**
 * Legacy/test helper for explicitly creating a `#general` fixture. Production Workspace/member/
 * Agent creation no longer auto-creates or auto-enrolls #general.
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
  // A private Agent is never an active channel member. Even this legacy/test
  // #general fixture must not enroll one, and later repair/backfill passes keep it out too.
  const agents = await db.agent.findMany({
    where: { workspaceId, visibility: AGENT_VISIBILITY.PUBLIC, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
  await db.conversationMember.createMany({
    data: agents.map(({ id: agentId }) => ({
      workspaceId,
      conversationId: general.id,
      agentId,
    })),
    skipDuplicates: true,
  });
  return general;
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
    where: {
      conversationId,
      threadRootId: null,
      id: messageAnchorWhere(anchor),
    },
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
  constructor(
    private readonly db: PrismaClient,
    private readonly idempotency?: MessageRequestIdempotency,
    private readonly publisher?: CentrifugoServerApi,
    private readonly notifications?: MessageNotifier,
    private readonly realtime?: ConversationRealtime,
  ) {}

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

  /** Pins this conversation for this member only, appending it after the member's other pins
   * unless a caller supplies an order. Unpinning removes the row rather than zeroing it, so
   * membership and pin state stay independent of archive/leave (see `ConversationPin`). */
  async setUserPinned(
    workspaceId: string,
    userId: string,
    channelId: string,
    pinned: boolean,
    sortOrder?: number,
  ) {
    const channel = await this.channel(workspaceId, userId, channelId);
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, channel.id);
      const member = await tx.conversationMember.findFirst({
        where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
        select: { id: true },
      });
      if (!member) throw new AppError("ACCESS_DENIED");
      const where = { conversationId: channel.id, memberId: member.id };
      if (!pinned) {
        await tx.conversationPin.deleteMany({ where });
        return;
      }
      const key = { conversationId_memberId: where };
      const order =
        sortOrder ?? (await tx.conversationPin.count({ where: { memberId: member.id } }));
      await tx.conversationPin.upsert({
        where: key,
        create: {
          conversationId: channel.id,
          memberId: member.id,
          workspaceId,
          sortOrder: order,
        },
        update: { sortOrder: order },
      });
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

  async list(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    const [channels, unread] = await Promise.all([
      this.db.conversation.findMany({
        where: { workspaceId, channelName: { not: null } },
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
      // member's own read cursor. System messages (no sender member) and the viewer's own
      // messages are already-read by definition; a soft-left membership has no badge. Driven
      // from the viewer's own channel memberships so the sequence range is an index condition
      // against `messages(conversationId, threadRootId, sequence)`, never a workspace-wide scan.
      // `arrivedSinceClosed` counts the unread ones posted after the member closed the chat:
      // any of them brings a closed chat back to the list.
      this.db.$queryRaw<{ conversationId: string; unread: number; arrivedSinceClosed: number }[]>`
        SELECT cm."conversationId" AS "conversationId", COUNT(m."id")::int AS "unread",
          COUNT(m."id") FILTER (WHERE m."createdAt" > cm."hiddenAt")::int AS "arrivedSinceClosed"
        FROM "conversation_members" cm
        JOIN "conversations" c
          ON c."id" = cm."conversationId"
         AND c."workspaceId" = ${workspaceId}::uuid
         AND c."channelName" IS NOT NULL
        LEFT JOIN "messages" m
          ON m."conversationId" = cm."conversationId"
         AND m."threadRootId" IS NULL
         AND m."senderMemberId" IS NOT NULL
         AND m."senderMemberId" IS DISTINCT FROM cm."id"
         AND (
           m."sequence" > cm."readThroughSequence"
           OR cm."unreadFromSequence" IS NOT NULL AND m."sequence" >= cm."unreadFromSequence"
         )
        WHERE cm."userId" = ${userId}::uuid
          AND cm."leftAt" IS NULL
          AND cm."workspaceId" = ${workspaceId}::uuid
        GROUP BY cm."conversationId"
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
      .filter((channel) => !channel.hidden)
      .sort((a, b) =>
        // Pinned conversations sit above the rest, in the order the member arranged them (#121).
        a.pinned || b.pinned
          ? Number(b.pinned) - Number(a.pinned) || (a.pinSortOrder ?? 0) - (b.pinSortOrder ?? 0)
          : Number(b.name === "general") - Number(a.name === "general"),
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
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new AppError("INVALID_INPUT");
    // The built-in #general channel was removed; keep the old reserved name from coming back.
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
      if (error instanceof Error && "code" in error && error.code === "P2002")
        throw new AppError("CONFLICT");
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

  private async channel(workspaceId: string, userId: string, channelId: string) {
    await this.authorize(workspaceId, userId);
    const channel = await this.db.conversation.findFirst({
      where: { id: channelId, workspaceId, channelName: { not: null } },
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
    await this.channel(workspaceId, userId, channelId);
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
    await this.realtime?.memberChanged({ conversationId: channelId, workspaceId });
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
   * "It's not possible to leave a reserved legacy #general channel"). Soft-left (`leftAt` set), not
   * deleted: the same row's mute preference and read boundary survive a later `join`, which clears
   * `leftAt` again.
   */
  async leave(workspaceId: string, userId: string, channelId: string) {
    const channel = await this.channel(workspaceId, userId, channelId);
    if (channel.channelName === "general") throw new AppError("CONFLICT");
    const wasMember = await softLeaveMember(this.db, channel.id, { userId });
    if (!wasMember) throw new AppError("ACCESS_DENIED");
    await this.realtime?.memberChanged({ conversationId: channel.id, workspaceId });
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
      where: { id: channelId, workspaceId, channelName: { not: null } },
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
    if (wasMember) await this.realtime?.memberChanged({ conversationId: channel.id, workspaceId });
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
      where: { id: channelId, workspaceId, channelName: { not: null } },
      select: { id: true, channelName: true },
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
      canAddMembers: isActiveMember,
      // The actor's own channel role/admin basis/capabilities on this channel.
      channelRole: actorRow?.channelRole,
      channelAdminBasis: actorAdminBasis,
      channelCapabilities: capabilities,
      // Aliases of the capability matrix above, kept for the existing human UI
      // (`ChannelMembersDialog`'s Remove/Leave actions): `remove_member`/`leave` are now the
      // single source of truth, a strict superset of the original owner/admin-only rule
      // — a channel admin via `channelRole` (not just a Workspace owner/admin) may also remove
      // members from a channel it administers.
      canRemoveMembers: capabilities.remove_member,
      canLeave: capabilities.leave,
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
      where: { id: channelId, workspaceId, channelName: { not: null } },
      select: { id: true },
    });
    if (!channel) throw new AppError("NOT_FOUND");

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
    if (added > 0) await this.realtime?.memberChanged({ conversationId: channelId, workspaceId });

    const result = await this.members(workspaceId, actor, channelId);
    return { ...result, alreadyMemberUserIds, alreadyMemberAgentIds };
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
    const [member, messages, mentionRows, viewerRecentMentions] = await Promise.all([
      // Filtered through ACTIVE_MEMBER_WHERE (not findUnique on the raw row): a human who left or
      // was removed must see the read-only preview (`senderMemberId` empty) like anyone who never
      // joined, not their old member state. The row itself survives untouched for a later rejoin.
      this.db.conversationMember.findFirst({
        where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
        include: {
          threadReads: true,
          threadFollows: true,
          user: { select: { username: true } },
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
      // The viewer's own recent @-mentions in this channel, newest first: scores each
      // completion candidate by how recently and how often the viewer has mentioned them (see
      // `mentionAffinityScores`). Filtered through the message's sender relation rather than
      // the already-loading `member` above, so this stays part of the same parallel fetch; a
      // viewer with no messages here (never joined, or joined but never mentioned anyone)
      // naturally gets an empty list and every candidate scores 0.
      this.db.messageMention.findMany({
        where: { conversationId: channelId, message: { sender: { userId } } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { kind: true, actorId: true, createdAt: true },
      }),
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
      project: channel.project ?? undefined,
      senderMemberId: member?.id ?? "",
      viewerHandle: member?.user?.username,
      muted: member?.channelMuted ?? false,
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
      this.db.messageMention.findMany({
        where: { conversationId: channelId, message: { sender: { userId } } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { kind: true, actorId: true, createdAt: true },
      }),
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
          // transaction, so renders and delivery never re-parse prose.
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
          const resolution = normalizeMentionBody(
            body,
            activeMembers.map((channelMember) =>
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
          );
          // Task references (`task #68`) are resolved the same way and for the same reason: the
          // server decides what names a real task of this channel, stores a `<@task:N>` token, and
          // a renderer never has to parse prose. A number that names no task stays ordinary text.
          const referencedTaskNumbers = taskReferenceNumbers(resolution.body);
          const knownTaskNumbers = referencedTaskNumbers.length
            ? new Set(
                (
                  await tx.task.findMany({
                    where: { conversationId: channelId, number: { in: referencedTaskNumbers } },
                    select: { number: true },
                  })
                ).map((task) => task.number),
              )
            : new Set<number>();
          const taskResolution = resolveTaskReferences(resolution.body, (number) =>
            knownTaskNumbers.has(number),
          );
          if (root) {
            // Everyone who takes part in a thread is a follower: whoever replies, everyone the
            // reply @mentions, and — the first time the thread gets a reply — the author of the
            // message being replied to. Without that last one, a reply under someone's own
            // message never enrolls them, and since a thread reply is not a parent-channel post,
            // nothing would ever notify them of the discussion started under their message.
            const participants = [member.id, ...resolution.mentions.map((mention) => mention.key)];
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
          const mentionedAgentIds = resolution.mentions
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
              body: taskResolution.body,
              sequence,
              mentions: resolution.mentions.length
                ? {
                    create: resolution.mentions.map((mention) => ({
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
    // Every Agent's push goes out at once; a failure still rejects the send. Agents read plain
    // `@handle` text — the stored body keeps mentions as embedded-UUID tokens, so translate.
    const publisher = this.publisher ?? createCentrifugoServerApi();
    const agentBody = agentReadableBody(message.body, message.mentions);
    // Routed through the shared projection rather than two non-null assertions on
    // `sender.user`, which broke for an Agent-authored channel delivery.
    const sender = agentMessageSender(message.sender);
    await Promise.all(
      message.deliveries
        .filter((delivery) => delivery.agent.computerId)
        .map((delivery) =>
          publisher.publish(
            daemonControlChannel(input.workspaceId, delivery.agent.computerId!),
            encodeAgentMessageDelivery({
              protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
              method: AGENT_MESSAGE_METHOD,
              requestId,
              workspaceId,
              conversationId: channelId,
              agentId: delivery.agentId,
              messageId: message.id,
              deliveryId: delivery.deliveryId,
              sequence: message.sequence,
              body: agentBody,
              target: `#${channel.channelName}${message.threadRootId ? `:${message.threadRootId}` : ""}`,
              latestSenderKind: sender.kind,
              latestSenderHandle: sender.handle,
              latestSenderDescription: sender.description,
              mentionsAgent: deliveryMentionsAgent(message.mentions, delivery.agentId),
            }),
          ),
        ),
    );
    return message;
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
