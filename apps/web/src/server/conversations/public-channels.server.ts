import { lockConversation } from "./conversation-lock.server";
import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import {
  channelActorMemberWhere,
  deriveChannelAdminBasis,
  deriveChannelCapabilities,
  isChannelRole,
  resolveActorServerRole,
  resolveChannelAuthority,
} from "./channel-authority.server";
import { ACTIVE_AGENT_WHERE } from "../agents/active-agent.server";
import { browserSenderHandle, browserSenderName } from "./sender-display.server";
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
} from "../centrifugo/server-api.server";
import type { MessageNotifier } from "../notifications/web-push-composition.server";
import { normalizeMentionBody } from "@lrm/coforge-sdk/internal";
import {
  agentReadableBody,
  BROWSER_MESSAGE_MENTIONS_SELECT,
  browserMessageMention,
  mentionAffinityScores,
  type BrowserMessageMentionRow,
} from "./mentions";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
  type MessageReactionRow,
} from "./message-reactions.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import { workspaceUserAvatarUrl } from "../db/repositories/user-profile.repositories.server";
import { attachmentView } from "../attachments/attachment-view.server";
import type { ActionCardView } from "./action-cards.server";

/** A channel actor is either a human (by Workspace `userId`) or an Agent (by `agentId`); the
 * human/Web UI and the Agent CLI share `PublicChannels.members`/`addMembers` through this. */
export type ChannelActor = { userId: string } | { agentId: string };

/**
 * Soft-leaves one member's row (sets `leftAt`) if it is currently active; a no-op (returns
 * `false`) if the row is missing or already left. This is the one write both `leave` and
 * `removeMember` use, for both the human/Web UI (`PublicChannels.leave`/`removeMember`) and the
 * Agent CLI (`AgentChannelManagement.leave`/`removeMember`, ADR 0024/0031) — the soft-leave write
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

/** Nested creation keeps default enrollment inside the Workspace creation transaction. */
export function generalChannelForCreator(userId: string) {
  return {
    create: { channelName: "general", members: { create: { userId } } },
  };
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
      agent: { select: { name: true, displayName: true, deletedAt: true } },
      user: {
        select: { id: true, username: true, displayName: true, avatarObjectKey: true },
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
    agent: { name: string; displayName: string | null; deletedAt: Date | null } | null;
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
    /** True when the sending Agent has since been deleted (ADR 0044): the row renders its sender
     * greyed with a `DELETED` marker, and no longer opens that Agent's profile. */
    senderDeleted: Boolean(message.sender?.agent?.deletedAt),
    senderAvatarUrl: message.sender?.user
      ? workspaceUserAvatarUrl(
          workspaceId,
          message.sender.user.id,
          message.sender.user.avatarObjectKey,
        )
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
 * Enroll every Workspace human and Agent in #general. Called from the write
 * points that add members (invitation acceptance, Agent creation); Workspace
 * creation enrolls the creator inline and the 20260915120000 migration
 * backfilled older rows, so reads never enroll.
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
  const agents = await db.agent.findMany({
    where: { workspaceId, ...ACTIVE_AGENT_WHERE },
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
      id:
        anchor.length === 8
          ? {
              gte: `${anchor}-0000-0000-0000-000000000000`,
              lte: `${anchor}-ffff-ffff-ffff-ffffffffffff`,
            }
          : anchor,
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
              // Slack-style unread cursor (ADR 0043). Thread replies belong to their thread
              // target and never advance it, so they never count in the channel badge.
              readThroughSequence: true,
            },
          },
        },
      }),
      // One query for every channel's unread: other-authored top-level messages past the
      // member's own read cursor. System messages (no sender member) and the viewer's own
      // messages are already-read by definition; a soft-left membership has no badge.
      this.db.$queryRaw<{ conversationId: string; unread: number }[]>`
        SELECT m."conversationId" AS "conversationId", COUNT(*)::int AS "unread"
        FROM "messages" m
        JOIN "conversation_members" cm
          ON cm."conversationId" = m."conversationId"
         AND cm."userId" = ${userId}::uuid
         AND cm."leftAt" IS NULL
         AND m."sequence" > cm."readThroughSequence"
        WHERE m."workspaceId" = ${workspaceId}::uuid
          AND m."threadRootId" IS NULL
          AND m."senderMemberId" IS NOT NULL
          AND (m."senderMemberId" IS DISTINCT FROM cm."id")
          AND EXISTS (
            SELECT 1 FROM "conversations" c
            WHERE c."id" = m."conversationId" AND c."workspaceId" = ${workspaceId}::uuid
              AND c."channelName" IS NOT NULL
          )
        GROUP BY m."conversationId"
      `,
    ]);
    const unreadByConversation = new Map(unread.map((row) => [row.conversationId, row.unread]));
    return channels
      .map((channel) => {
        const member = channel.members[0];
        // A non-member (or soft-left viewer) sees no unread badge: the channel's history is
        // readable, but nothing new is "for them" until they join.
        return {
          id: channel.id,
          name: channel.channelName!,
          joined: Boolean(member),
          archived: channel.archivedAt !== null,
          muted: member?.channelMuted ?? false,
          unreadCount: member ? (unreadByConversation.get(channel.id) ?? 0) : 0,
        };
      })
      .sort((a, b) => Number(b.name === "general") - Number(a.name === "general"));
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
    // general is reserved for automatic enrollment, including before the first list request.
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
          // The creator becomes the channel's first admin (ADR 0030).
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
   * Promotes/demotes a channel member's stored `channelRole` (ADR 0030). Human-only: there is
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
      await this.db.conversationMember.upsert({
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
  }

  /**
   * Advances the human member's top-level read cursor (ADR 0043). Monotone and clamped to the
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
    });
  }

  /**
   * A human leaves a public channel they are an active member of themselves ("Leave a channel",
   * Slack: any member may leave a channel they belong to). Never `#general` (`CONFLICT`, Slack:
   * "It's not possible to leave the default #general channel"). Soft-left (`leftAt` set), not
   * deleted: the same row's mute preference and read boundary survive a later `join`, which clears
   * `leftAt` again. ADR 0031.
   */
  async leave(workspaceId: string, userId: string, channelId: string) {
    const channel = await this.channel(workspaceId, userId, channelId);
    if (channel.channelName === "general") throw new AppError("CONFLICT");
    const wasMember = await softLeaveMember(this.db, channel.id, { userId });
    if (!wasMember) throw new AppError("ACCESS_DENIED");
    return { left: true };
  }

  /**
   * A channel admin (either basis) removes a human or Agent from a public channel — originally
   * Slack's "Workspace Owners and Admins can remove people from public channels" (ADR 0031), now
   * generalized to the `remove_member` capability (ADR 0030) so a channel admin via stored
   * `channelRole` may also remove members from a channel it administers, the same authority the
   * Agent CLI's `remove-member` already has (ADR 0024). Never `#general` (`CONFLICT`, Slack:
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
    return { removed: true, wasMember };
  }

  /**
   * Current members split into humans and Agents, plus candidates (Workspace
   * humans and Agents not yet members) and whether the actor may add members
   * (has an active ConversationMember row in this channel). Any Workspace
   * member or Agent may read this; channels are public within the Workspace.
   * Shared by the human "Members" dialog and the Agent CLI's `channel
   * members`/`add-member` (see ADR 0024/0025); a soft-left row (`leftAt` set)
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
            },
          },
        },
      }),
      this.db.user.findMany({
        where: { memberships: { some: { workspaceId } } },
        select: { id: true, username: true, displayName: true, avatarObjectKey: true },
        orderBy: [{ username: "asc" }, { id: "asc" }],
      }),
      this.db.agent.findMany({
        where: { workspaceId, weeklyReportAssistant: null, ...ACTIVE_AGENT_WHERE },
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
      // The actor's own channel role/admin basis/capabilities on this channel (ADR 0030).
      channelRole: actorRow?.channelRole,
      channelAdminBasis: actorAdminBasis,
      channelCapabilities: capabilities,
      // Aliases of the capability matrix above, kept for the existing ADR 0031 human UI
      // (`ChannelMembersDialog`'s Remove/Leave actions): `remove_member`/`leave` are now the
      // single source of truth, a strict superset of ADR 0031's original owner/admin-only rule
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
      const validAgents = await this.db.agent.count({
        where: { workspaceId, id: { in: agentIds }, ...ACTIVE_AGENT_WHERE },
      });
      if (validAgents !== agentIds.length) throw new AppError("INVALID_INPUT");
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
    // what arrives after the add, never the backlog that existed before (mirrors `join`).
    const cursor = await this.db.message.findFirst({
      where: { conversationId: channelId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    await Promise.all([
      ...userIds.map((userId) =>
        this.db.conversationMember.upsert({
          where: { conversationId_userId: { conversationId: channelId, userId } },
          create: {
            workspaceId,
            conversationId: channelId,
            userId,
            readThroughSequence: cursor?.sequence ?? 0,
          },
          update: { leftAt: null, readThroughSequence: cursor?.sequence ?? 0 },
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

    const result = await this.members(workspaceId, actor, channelId);
    return { ...result, alreadyMemberUserIds, alreadyMemberAgentIds };
  }

  async open(
    workspaceId: string,
    userId: string,
    channelId: string,
    page: { beforeSequence?: number; limit?: number } = {},
  ) {
    const channel = await this.channel(workspaceId, userId, channelId);
    const limit = Math.min(page.limit ?? 50, 100);
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
          sequence: page.beforeSequence ? { lt: page.beforeSequence } : undefined,
        },
        orderBy: { sequence: "desc" },
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
          agent: { select: { id: true, name: true, displayName: true, description: true } },
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
    const hasOlder = messages.length > limit;
    const pageMessages = messages
      .slice(0, limit)
      .reverse()
      .flatMap((message) => [message, ...message.replies])
      .sort((left, right) => left.sequence - right.sequence);
    return {
      conversationId: channel.id,
      name: channel.channelName!,
      project: channel.project ?? undefined,
      senderMemberId: member?.id ?? "",
      viewerHandle: member?.user?.username,
      muted: member?.channelMuted ?? false,
      // The viewer's conversation-level read cursor over top-level messages (ADR 0046):
      // the client positions the initial view at the first unread message and draws the
      // divider there. Undefined for a non-member (nothing is "unread for them").
      readThroughSequence: member?.readThroughSequence,
      threadReadThrough: Object.fromEntries(
        (member?.threadReads ?? []).map((read) => [read.rootMessageId, read.readThroughSequence]),
      ),
      followedThreadRootIds: (member?.threadFollows ?? []).map((follow) => follow.rootMessageId),
      // The viewer never mentions themself, so their own row is left out of the candidate list.
      mentionables: mentionRows
        .filter((row) => row.user?.id !== userId)
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
                mentionScore: mentionScores.get(`agent:${row.agent!.id}`) ?? 0,
              },
        )
        .sort((left, right) => left.handle.localeCompare(right.handle)),
      hasOlder,
      hasNewer: false,
      messages: pageMessages.map((message) => channelMessageView(message, workspaceId)),
    };
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
                select: { id: true, threadRootId: true },
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
          const attachmentRowIds: string[] = [];
          for (const attachmentId of attachmentIds ?? []) {
            const attachment = await tx.attachment.findFirst({
              where: {
                id: attachmentId,
                conversationId: channelId,
                workspaceId,
                uploaderId: userId,
                messageId: null,
              },
              select: { id: true },
            });
            if (!attachment) throw new AppError("ACCESS_DENIED");
            attachmentRowIds.push(attachment.id);
          }
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
          if (root) {
            await tx.threadFollow.createMany({
              data: [member.id, ...resolution.mentions.map((mention) => mention.key)].map(
                (memberId) => ({
                  memberId,
                  rootMessageId: root.id,
                  conversationId: channelId,
                  workspaceId,
                }),
              ),
              skipDuplicates: true,
            });
          }
          // Directed delivery: a message that @mentions at least one Agent wakes exactly those
          // Agents (a mention pierces mute), and no others. Without an Agent mention, every
          // unmuted Agent member (plus thread followers on a reply) receives it and each decides
          // whether to reply. Mentioning only humans never narrows Agent delivery.
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
                    OR: [
                      { channelMuted: false },
                      ...(root ? [{ threadFollows: { some: { rootMessageId: root.id } } }] : []),
                    ],
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
              body: resolution.body,
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
        sender: {
          select: {
            user: { select: { username: true, displayName: true, avatarObjectKey: true } },
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
        });
      } catch {
        // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
      }
    }
    // Every Agent's push goes out at once; a failure still rejects the send. Agents read plain
    // `@handle` text — the stored body keeps mentions as embedded-UUID tokens, so translate.
    const publisher = this.publisher ?? createCentrifugoServerApi();
    const agentBody = agentReadableBody(message.body, message.mentions);
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
              latestSender: `@${message.sender!.user!.username}`,
            }),
          ),
        ),
    );
    return message;
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
