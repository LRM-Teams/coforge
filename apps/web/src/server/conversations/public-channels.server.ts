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
        },
      }),
    ]);
    const hasOlder = messages.length > limit;
    return {
      conversationId: channel.id,
      name: channel.channelName!,
      senderMemberId: member?.id ?? "",
      muted: member?.channelMuted ?? false,
      hasOlder,
      hasNewer: false,
      messages: messages
        .slice(0, limit)
        .reverse()
        .map((message) => ({
          id: message.id,
          sequence: message.sequence,
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
        threadRootId: null,
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
  }) {
    const { workspaceId, userId, channelId, requestId, attachmentId } = input;
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
          const recipients = await tx.conversationMember.findMany({
            where: {
              conversationId: channelId,
              agentId: { not: null },
              agent: { workspaceId },
              OR: [{ channelMuted: false }, { agent: { name: { in: names } } }],
            },
            select: { agentId: true },
          });
          const sequence = (latest?.sequence ?? 0) + 1;
          const message = await tx.message.create({
            data: {
              workspaceId,
              conversationId: channelId,
              senderMemberId: member.id,
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
          return { ...message, target: `#${channel.channelName}` };
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
          target: `#${channel.channelName}`,
          latestSender: `@${message.sender.user!.username}`,
        }),
      );
    }
    return message;
  }
}
