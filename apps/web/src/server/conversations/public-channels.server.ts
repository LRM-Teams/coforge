import { lockConversation } from "./conversation-lock.server";
import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
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
import { mentionedNames } from "./mentions";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
  type MessageReactionRow,
} from "./message-reactions.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import { workspaceUserAvatarUrl } from "../db/repositories/user-profile.repositories.server";
import { attachmentView } from "../attachments/attachment-view.server";

/** A channel actor is either a human (by Workspace `userId`) or an Agent (by `agentId`); the
 * human/Web UI and the Agent CLI share `PublicChannels.members`/`addMembers` through this. */
export type ChannelActor = { userId: string } | { agentId: string };

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
      agent: { select: { name: true } },
      user: { select: { id: true, username: true, avatarObjectKey: true } },
    },
  },
  attachment: {
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, objectKey: true },
  },
  reactions: MESSAGE_REACTIONS_SELECT,
} satisfies Prisma.MessageSelect;

type ChannelMessageRow = {
  id: string;
  sequence: number;
  threadRootId: string | null;
  senderMemberId: string | null;
  body: string;
  createdAt: Date;
  sender: {
    agentId: string | null;
    agent: { name: string } | null;
    user: { id: string; username: string; avatarObjectKey: string | null } | null;
  } | null;
  attachment: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    objectKey: string;
  } | null;
  reactions: MessageReactionRow[];
};

/** The browser-facing shape of one channel message, shared by page and update reads. */
function channelMessageView(message: ChannelMessageRow, workspaceId: string) {
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
    senderName: !message.sender
      ? "System"
      : `@${message.sender.agent?.name ?? message.sender.user!.username}`,
    senderAvatarUrl: message.sender?.user
      ? workspaceUserAvatarUrl(
          workspaceId,
          message.sender.user.id,
          message.sender.user.avatarObjectKey,
        )
      : null,
    body: message.body,
    createdAt: message.createdAt,
    attachment: message.attachment ? attachmentView(message.attachment) : undefined,
    reactions: reactionSummaries(message.reactions),
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
  await db.conversationMember.createMany({
    data: members.map(({ userId }) => ({
      workspaceId,
      conversationId: general.id,
      userId,
    })),
    skipDuplicates: true,
  });
  const agents = await db.agent.findMany({
    where: { workspaceId },
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
    const member = await this.db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: channelId, userId } },
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
    const rows = await this.db.message.findMany({
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
      where: { id: actor.agentId, workspaceId },
      select: { id: true },
    });
    if (!agent) throw new AppError("ACCESS_DENIED");
  }

  /** A `ConversationMember` `where` clause identifying `actor`'s own row in a channel. */
  private actorMemberWhere(actor: ChannelActor) {
    return "userId" in actor ? { userId: actor.userId } : { agentId: actor.agentId };
  }

  async list(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    const channels = await this.db.conversation.findMany({
      where: { workspaceId, channelName: { not: null } },
      orderBy: { channelName: "asc" },
      select: {
        id: true,
        channelName: true,
        archivedAt: true,
        members: { where: { userId, ...ACTIVE_MEMBER_WHERE }, select: { id: true } },
      },
    });
    return channels
      .map((channel) => ({
        id: channel.id,
        name: channel.channelName!,
        joined: channel.members.length > 0,
        archived: channel.archivedAt !== null,
      }))
      .sort((a, b) => Number(b.name === "general") - Number(a.name === "general"));
  }

  async create(workspaceId: string, userId: string, name: string, projectId?: string) {
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
          members: { create: { userId } },
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "P2002")
        throw new AppError("CONFLICT");
      throw error;
    }
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
    await this.db.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: channelId, userId } },
      create: { workspaceId, userId, conversationId: channelId },
      update: { leftAt: null },
    });
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
      select: { id: true },
    });
    if (!channel) throw new AppError("NOT_FOUND");

    const [memberRows, workspaceUsers, workspaceAgents] = await Promise.all([
      this.db.conversationMember.findMany({
        where: { conversationId: channelId, ...ACTIVE_MEMBER_WHERE },
        select: {
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
        where: { workspaceId, weeklyReportAssistant: null },
        select: { id: true, name: true, displayName: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
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

    return {
      canAddMembers:
        "userId" in actor ? memberUserIds.has(actor.userId) : memberAgentIds.has(actor.agentId),
      humans: memberRows
        .filter((row) => row.user)
        .map((row) => ({
          id: row.user!.id,
          username: row.user!.username,
          displayName: row.user!.displayName?.trim() || row.user!.username,
          avatarUrl: workspaceUserAvatarUrl(workspaceId, row.user!.id, row.user!.avatarObjectKey),
          role: roleByUserId.get(row.user!.id) ?? "member",
        })),
      agents: memberRows
        .filter((row) => row.agent)
        .map((row) => ({
          id: row.agent!.id,
          name: row.agent!.name,
          displayName: row.agent!.displayName?.trim() || row.agent!.name,
          description: row.agent!.description,
          role: row.agent!.role,
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
      where: { conversationId: channelId, ...this.actorMemberWhere(actor), ...ACTIVE_MEMBER_WHERE },
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
        where: { workspaceId, id: { in: agentIds } },
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

    await Promise.all([
      ...userIds.map((userId) =>
        this.db.conversationMember.upsert({
          where: { conversationId_userId: { conversationId: channelId, userId } },
          create: { workspaceId, conversationId: channelId, userId },
          update: { leftAt: null },
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
    const [member, messages] = await Promise.all([
      this.db.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: channelId, userId } },
        include: { threadReads: true, threadFollows: true },
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
    ]);
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
      muted: member?.channelMuted ?? false,
      threadReadThrough: Object.fromEntries(
        (member?.threadReads ?? []).map((read) => [read.rootMessageId, read.readThroughSequence]),
      ),
      followedThreadRootIds: (member?.threadFollows ?? []).map((follow) => follow.rootMessageId),
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
    attachmentId?: string;
    threadRootId?: string;
  }) {
    const { workspaceId, userId, channelId, requestId, attachmentId, threadRootId } = input;
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
          if (attachmentId) {
            const attachment = await tx.attachment.findFirst({
              where: {
                id: attachmentId,
                conversationId: channelId,
                workspaceId,
                uploaderId: userId,
                messageId: null,
              },
            });
            if (!attachment) throw new AppError("ACCESS_DENIED");
          }
          const names = mentionedNames(body);
          if (root) {
            const mentioned = await tx.conversationMember.findMany({
              where: {
                conversationId: channelId,
                OR: [{ user: { username: { in: names } } }, { agent: { name: { in: names } } }],
                ...ACTIVE_MEMBER_WHERE,
              },
              select: { id: true },
            });
            await tx.threadFollow.createMany({
              data: [member.id, ...mentioned.map(({ id }) => id)].map((memberId) => ({
                memberId,
                rootMessageId: root.id,
                conversationId: channelId,
                workspaceId,
              })),
              skipDuplicates: true,
            });
          }
          const recipients = await tx.conversationMember.findMany({
            where: {
              conversationId: channelId,
              agentId: { not: null },
              agent: { workspaceId },
              ...ACTIVE_MEMBER_WHERE,
              OR: [
                { channelMuted: false },
                { agent: { name: { in: names } } },
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
              body,
              sequence,
              attachment: attachmentId ? { connect: { id: attachmentId } } : undefined,
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
          created = true;
          return {
            ...message,
            target: `#${channel.channelName}${root ? `:${root.id}` : ""}`,
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
        sender: { select: { user: { select: { username: true, avatarObjectKey: true } } } },
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
        });
      } catch {
        // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
      }
    }
    // Every Agent's push goes out at once; a failure still rejects the send.
    const publisher = this.publisher ?? createCentrifugoServerApi();
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
              body: message.body,
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
