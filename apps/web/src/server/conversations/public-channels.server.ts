import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import { getMessageRequestIdempotency } from "./redis-message-request-idempotency.server";
import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
} from "@coforge/protocol";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  type CentrifugoServerApi,
} from "../centrifugo/server-api.server";
import type { MessageNotifier } from "../notifications/web-push-composition.server";
import { mentionedNames } from "./mentions";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";

/** Nested creation keeps default enrollment inside the Workspace creation transaction. */
export function generalChannelForCreator(userId: string) {
  return {
    create: { channelName: "general", members: { create: { userId } } },
  };
}

/** Enroll Workspace humans and Agents. Membership alone never creates attention. */
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
      members: { some: { agentId, agent: { workspaceId } } },
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
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${channel.id}::uuid FOR UPDATE`;
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
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${channel.id}::uuid FOR UPDATE`;
      const updated = await tx.conversationMember.updateMany({
        where: { conversationId: channel.id, userId },
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
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
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

  async list(workspaceId: string, userId: string) {
    await this.authorize(workspaceId, userId);
    await this.db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
    const channels = await this.db.conversation.findMany({
      where: { workspaceId, channelName: { not: null } },
      orderBy: { channelName: "asc" },
      select: {
        id: true,
        channelName: true,
        members: { where: { userId }, select: { id: true } },
      },
    });
    return channels
      .map((channel) => ({
        id: channel.id,
        name: channel.channelName!,
        joined: channel.members.length > 0,
      }))
      .sort((a, b) => Number(b.name === "general") - Number(a.name === "general"));
  }

  async create(workspaceId: string, userId: string, name: string) {
    await this.authorize(workspaceId, userId);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new AppError("INVALID_INPUT");
    // general is reserved for automatic enrollment, including before the first list request.
    if (name === "general") throw new AppError("CONFLICT");
    try {
      return await this.db.conversation.create({
        data: {
          workspaceId,
          channelName: name,
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
    });
    if (!channel) throw new AppError("NOT_FOUND");
    if (channel.channelName === "general")
      await this.db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
    return channel;
  }

  async join(workspaceId: string, userId: string, channelId: string) {
    await this.channel(workspaceId, userId, channelId);
    await this.db.conversationMember.createMany({
      data: { workspaceId, userId, conversationId: channelId },
      skipDuplicates: true,
    });
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
        include: {
          sender: { include: { user: true, agent: true } },
          attachment: true,
          replies: {
            orderBy: { sequence: "asc" },
            include: {
              sender: { include: { user: true, agent: true } },
              attachment: true,
            },
          },
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
      senderMemberId: member?.id ?? "",
      muted: member?.channelMuted ?? false,
      threadReadThrough: Object.fromEntries(
        (member?.threadReads ?? []).map((read) => [read.rootMessageId, read.readThroughSequence]),
      ),
      followedThreadRootIds: (member?.threadFollows ?? []).map((follow) => follow.rootMessageId),
      hasOlder,
      hasNewer: false,
      messages: pageMessages.map((message) => ({
        id: message.id,
        sequence: message.sequence,
        threadRootId: message.threadRootId ?? undefined,
        senderMemberId: message.senderMemberId,
        senderKind: message.sender.agentId ? ("agent" as const) : ("user" as const),
        senderName: `@${message.sender.agent?.name ?? message.sender.user!.username}`,
        body: message.body,
        createdAt: message.createdAt,
        attachment: message.attachment
          ? {
              id: message.attachment.id,
              fileName: message.attachment.fileName,
              contentType: message.attachment.contentType,
              sizeBytes: message.attachment.sizeBytes,
            }
          : undefined,
      })),
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
      include: {
        sender: { include: { user: true, agent: true } },
        attachment: true,
      },
    });
    return messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      threadRootId: message.threadRootId ?? undefined,
      senderMemberId: message.senderMemberId,
      senderKind: message.sender.agentId ? ("agent" as const) : ("user" as const),
      senderName: `@${message.sender.agent?.name ?? message.sender.user!.username}`,
      body: message.body,
      createdAt: message.createdAt,
      attachment: message.attachment
        ? {
            id: message.attachment.id,
            fileName: message.attachment.fileName,
            contentType: message.attachment.contentType,
            sizeBytes: message.attachment.sizeBytes,
          }
        : undefined,
    }));
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
    const member = await this.db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: channelId, userId } },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    const body = input.body.trim();
    if (!body || body.length > 8_000) throw new AppError("INVALID_INPUT");
    let created = false;
    const saved = await (this.idempotency ?? getMessageRequestIdempotency()).execute(
      { workspaceId, senderKind: "user", senderId: userId, requestId },
      () =>
        this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${channelId}::uuid FOR UPDATE`;
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
      include: {
        sender: { include: { user: true } },
        deliveries: { include: { agent: true } },
        attachment: true,
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
    for (const delivery of message.deliveries) {
      if (!delivery.agent.computerId) continue;
      await (this.publisher ?? createCentrifugoServerApi()).publish(
        daemonControlChannel(input.workspaceId, delivery.agent.computerId),
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
          latestSender: `@${message.sender.user!.username}`,
        }),
      );
    }
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
