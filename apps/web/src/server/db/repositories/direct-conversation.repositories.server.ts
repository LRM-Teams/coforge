import type { Prisma, PrismaClient } from "../../../../generated/client";

export type AttachmentMetadata = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type DirectConversationPage = {
  messages: {
    id: string;
    sequence: number;
    sender: string;
    body: string;
    createdAt: Date;
    target: string;
    attachment?: AttachmentMetadata;
  }[];
  hasOlder: boolean;
  hasNewer: boolean;
};

export type DirectConversationPageOptions = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  fromSequence?: number;
  throughSequence?: number;
};

export type AgentRecoveryContext = {
  resumeMessages: Array<{
    messageId: string;
    deliveryId: string;
    conversationId: string;
    sequence: number;
    target: string;
    latestSender: string;
  }>;
  unreadSummary: Readonly<Record<string, number>>;
};

const AGENT_RECOVERY_MESSAGE_LIMIT = 100;

type DirectConversationMessageRow = Prisma.MessageGetPayload<{
  include: { sender: { include: { agent: true } }; attachment: true };
}>;

export type DirectConversationRepository = {
  userIdForUsername?(target: string): Promise<string>;
  getOrCreateUserAgent(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{ id: string }>;
  sendMessage(
    conversationId: string,
    senderMemberId: string,
    senderUserId: string,
    body: string,
    attachmentId?: string,
  ): Promise<{
    id: string;
    body: string;
    createdAt: Date;
    sequence: number;
    deliveryId?: string;
    workspaceId: string;
    agentId: string;
    computerId?: string;
    target?: string;
    latestSender?: string;
    attachment?: AttachmentMetadata;
  }>;
  receiveDeliveryAck?(input: {
    workspaceId: string;
    agentId: string;
    deliveryId?: string;
    messageId: string;
    sequence: number;
  }): Promise<void>;
  readMessages?(
    workspaceId: string,
    agentId: string,
    target: string,
    page?: DirectConversationPageOptions,
  ): Promise<
    {
      id: string;
      sequence: number;
      sender: string;
      body: string;
      createdAt: Date;
      target: string;
      attachment?: AttachmentMetadata;
    }[]
  >;
  readMessagesPage?(
    workspaceId: string,
    agentId: string,
    target: string,
    page?: DirectConversationPageOptions,
  ): Promise<DirectConversationPage>;
  readPendingAgentContext?(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ): ReturnType<NonNullable<DirectConversationRepository["readMessages"]>>;
  readAgentRecoveryContext?(workspaceId: string, agentId: string): Promise<AgentRecoveryContext>;
  sendAgentMessage?(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentId?: string,
  ): Promise<{
    id: string;
    body: string;
    createdAt: Date;
    sequence: number;
    deliveryId?: string;
    workspaceId: string;
    agentId: string;
    target: string;
    attachment?: AttachmentMetadata;
  }>;
  openForUser?(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{
    conversationId: string;
    senderMemberId: string;
    agent: { id: string; name: string; displayName: string };
    messages: Array<{
      id: string;
      sequence: number;
      senderKind: "user" | "agent";
      senderName: string;
      body: string;
      createdAt: Date;
      attachment?: AttachmentMetadata;
    }>;
  }>;
};

const keyFor = (userId: string, agentId: string) => `agent:${agentId}|user:${userId}`;

export const buildUserAgentConversationCreateInput = (
  workspaceId: string,
  userId: string,
  agentId: string,
) =>
  ({
    workspace: { connect: { id: workspaceId } },
    directKey: keyFor(userId, agentId),
    members: {
      create: [
        {
          workspace: { connect: { id: workspaceId } },
          user: { connect: { id: userId } },
        },
        {
          workspace: { connect: { id: workspaceId } },
          agent: { connect: { id: agentId } },
        },
      ],
    },
  }) satisfies Prisma.ConversationCreateInput;

export class PrismaDirectConversationRepository implements DirectConversationRepository {
  constructor(private readonly db: PrismaClient) {}
  async userIdForUsername(target: string) {
    const user = await this.db.user.findUnique({
      where: { username: target.replace(/^@/, "") },
      select: { id: true },
    });
    if (!user) throw new Error("target user not found");
    return user.id;
  }

  async getOrCreateUserAgent(workspaceId: string, userId: string, agentId: string) {
    const [membership, agent] = await Promise.all([
      this.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
      }),
      this.db.agent.findUnique({ where: { id: agentId } }),
    ]);
    if (!membership || !agent || agent.workspaceId !== workspaceId)
      throw new Error("conversation scope is not authorized");
    const directKey = keyFor(userId, agentId);
    const existing = await this.db.conversation.findUnique({
      where: { workspaceId_directKey: { workspaceId, directKey } },
    });
    if (existing) return existing;
    return this.db.conversation.create({
      data: buildUserAgentConversationCreateInput(workspaceId, userId, agentId),
      select: { id: true },
    });
  }

  async openForUser(workspaceId: string, userId: string, agentId: string) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const row = await this.db.conversation.findUnique({
      where: { id: conversation.id },
      select: {
        members: {
          select: {
            id: true,
            userId: true,
            agentId: true,
            user: { select: { username: true } },
            agent: { select: { id: true, name: true, displayName: true } },
          },
        },
        messages: {
          orderBy: { sequence: "asc" },
          select: {
            id: true,
            sequence: true,
            body: true,
            createdAt: true,
            attachment: {
              select: { id: true, fileName: true, contentType: true, sizeBytes: true },
            },
            sender: {
              select: {
                userId: true,
                user: { select: { username: true } },
                agent: { select: { name: true, displayName: true } },
              },
            },
          },
        },
      },
    });
    const sender = row?.members.find((member) => member.userId === userId);
    const agentMember = row?.members.find((member) => member.agentId === agentId);
    if (!row || !sender || !agentMember?.agent)
      throw new Error("conversation scope is not authorized");
    return {
      conversationId: conversation.id,
      senderMemberId: sender.id,
      agent: agentMember.agent,
      messages: row.messages.map((message) => ({
        id: message.id,
        sequence: message.sequence,
        senderKind: message.sender.userId ? ("user" as const) : ("agent" as const),
        senderName: message.sender.userId
          ? `@${message.sender.user?.username}`
          : message.sender.agent?.displayName || message.sender.agent?.name || "Agent",
        body: message.body,
        createdAt: message.createdAt,
        attachment: message.attachment ?? undefined,
      })),
    };
  }

  async sendMessage(
    conversationId: string,
    senderMemberId: string,
    senderUserId: string,
    body: string,
    attachmentId?: string,
  ) {
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: {
        workspaceId: true,
        members: {
          select: {
            id: true,
            userId: true,
            agentId: true,
            user: { select: { username: true } },
            agent: { select: { name: true, computerId: true } },
          },
        },
      },
    });
    if (!conversation) throw new Error("conversation not found");
    const sender = conversation.members.find(
      (member) => member.id === senderMemberId && member.userId === senderUserId,
    );
    const agents = conversation.members.filter((member) => member.agentId !== null);
    if (!sender) throw new Error("sender is not a conversation member");
    if (conversation.members.length !== 2 || agents.length !== 1 || !agents[0]?.agentId)
      throw new Error("only User-Agent direct conversations are supported");
    const message = await this.db.$transaction(async (tx) => {
      // Serialize sequence allocators for this conversation before observing MAX(sequence).
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
      const last = await tx.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const sequence = (last?.sequence ?? 0) + 1;
      if (attachmentId) {
        const attachment = await tx.attachment.findFirst({
          where: {
            id: attachmentId,
            conversationId,
            workspaceId: conversation.workspaceId,
            uploaderId: senderUserId,
            messageId: null,
          },
          select: { id: true },
        });
        if (!attachment) throw new Error("attachment is not available for this message");
      }
      return tx.message.create({
        data: {
          conversationId,
          workspaceId: conversation.workspaceId,
          senderMemberId,
          body,
          attachment: attachmentId ? { connect: { id: attachmentId } } : undefined,
          sequence,
          deliveries: {
            create: {
              workspaceId: conversation.workspaceId,
              conversationId,
              agentId: agents[0]!.agentId!,
              sequence,
            },
          },
        },
        select: {
          id: true,
          body: true,
          createdAt: true,
          sequence: true,
          deliveries: { select: { deliveryId: true } },
          attachment: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } },
        },
      });
    });
    return {
      ...message,
      deliveryId: message.deliveries[0]!.deliveryId,
      workspaceId: conversation.workspaceId,
      agentId: agents[0].agentId,
      computerId: agents[0].agent?.computerId ?? undefined,
      target: `@${agents[0].agent?.name ?? "unknown"}`,
      latestSender: `@${sender.user?.username}`,
      attachment: message.attachment ?? undefined,
    };
  }

  async receiveDeliveryAck(input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
    messageId: string;
    sequence: number;
  }) {
    const result = await this.db.agentMessageDelivery.updateMany({
      where: {
        deliveryId: input.deliveryId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        messageId: input.messageId,
        sequence: input.sequence,
      },
      data: { receivedAt: new Date() },
    });
    if (result.count !== 1) throw new Error("delivery acknowledgement is not authorized");
  }

  async readMessages(
    workspaceId: string,
    agentId: string,
    target: string,
    page: DirectConversationPageOptions = {},
  ) {
    return (await this.readMessagesPage(workspaceId, agentId, target, page)).messages;
  }

  async readMessagesPage(
    workspaceId: string,
    agentId: string,
    target: string,
    page: DirectConversationPageOptions = {},
  ) {
    const userId = await this.userIdForUsername(target);
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const agentMember = await this.db.conversationMember.findFirst({
      where: { conversationId: conversation.id, agentId },
      select: { agentReadThroughSequence: true },
    });
    if (!agentMember) throw new Error("Agent is not a conversation member");
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 100);
    const anchor =
      (page.before ?? page.after ?? page.around)
        ? await this.db.message.findFirst({
            where: {
              id: page.before ?? page.after ?? page.around,
              conversationId: conversation.id,
            },
            select: { sequence: true },
          })
        : undefined;
    const include = { sender: { include: { agent: true } }, attachment: true } as const;
    const map = (rows: DirectConversationMessageRow[]) =>
      rows.map((m) => ({
        id: m.id,
        sequence: m.sequence,
        sender: m.sender.agentId ? `@${m.sender.agent?.name ?? "agent"}` : target,
        body: m.body,
        createdAt: m.createdAt,
        target,
        attachment: m.attachment ?? undefined,
      }));
    if (page.around && anchor) {
      const beforeCount = Math.floor((limit - 1) / 2);
      const afterCount = limit - 1 - beforeCount;
      const [beforeRows, anchorRows, afterRows] = await Promise.all([
        this.db.message.findMany({
          where: { conversationId: conversation.id, sequence: { lt: anchor.sequence } },
          orderBy: { sequence: "desc" },
          take: beforeCount + 1,
          include,
        }),
        this.db.message.findMany({
          where: { conversationId: conversation.id, sequence: anchor.sequence },
          take: 1,
          include,
        }),
        this.db.message.findMany({
          where: { conversationId: conversation.id, sequence: { gt: anchor.sequence } },
          orderBy: { sequence: "asc" },
          take: afterCount + 1,
          include,
        }),
      ]);
      const messages = map([
        ...beforeRows.slice(0, beforeCount).reverse(),
        ...anchorRows,
        ...afterRows.slice(0, afterCount),
      ]);
      return {
        messages,
        hasOlder: beforeRows.length > beforeCount,
        hasNewer: afterRows.length > afterCount,
      };
    }
    const isHistoryRead = Boolean(page.before || page.after || page.around);
    const effectiveFromSequence = isHistoryRead
      ? page.fromSequence
      : (page.fromSequence ?? agentMember.agentReadThroughSequence + 1);
    const effectiveSequence = {
      ...(effectiveFromSequence !== undefined ? { gte: effectiveFromSequence } : {}),
      ...(page.throughSequence !== undefined ? { lte: page.throughSequence } : {}),
      ...(anchor && page.before ? { lt: anchor.sequence } : {}),
      ...(anchor && page.after ? { gt: anchor.sequence } : {}),
    };
    const rows = await this.db.message.findMany({
      where: {
        conversationId: conversation.id,
        ...(Object.keys(effectiveSequence).length ? { sequence: effectiveSequence } : {}),
      },
      orderBy: { sequence: page.before ? "desc" : "asc" },
      take: limit + 1,
      include,
    });
    const hasMore = rows.length > limit;
    const messages = map(rows.slice(0, limit).sort((a, b) => a.sequence - b.sequence));
    const isBoundaryRead =
      !isHistoryRead && effectiveFromSequence === agentMember.agentReadThroughSequence + 1;
    const agentReadThroughSequence = isBoundaryRead ? (messages.at(-1)?.sequence ?? 0) : 0;
    if (agentReadThroughSequence) {
      await this.db.conversationMember.updateMany({
        where: {
          conversationId: conversation.id,
          agentId,
          agentReadThroughSequence: { lt: agentReadThroughSequence },
        },
        data: { agentReadThroughSequence },
      });
    }
    return {
      messages,
      hasOlder: page.after ? Boolean(anchor) : page.before ? hasMore : false,
      hasNewer: page.before ? Boolean(anchor) : page.after || !isHistoryRead ? hasMore : false,
    };
  }

  async readAgentRecoveryContext(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentRecoveryContext> {
    return this.db.$transaction(
      async (tx) => {
        const members = await tx.conversationMember.findMany({
          where: { workspaceId, agentId },
          orderBy: { conversationId: "asc" },
          select: {
            conversationId: true,
            agentReadThroughSequence: true,
            conversation: {
              select: {
                members: {
                  where: { userId: { not: null } },
                  select: { user: { select: { username: true } } },
                },
              },
            },
          },
        });
        const resumeMessages: AgentRecoveryContext["resumeMessages"] = [];
        const unreadSummary: Record<string, number> = {};
        for (const member of members) {
          const username = member.conversation.members[0]?.user?.username;
          if (!username) throw new Error("Agent conversation has no public user target");
          const target = `@${username}`;
          if (target in unreadSummary)
            throw new Error(`duplicate Agent recovery target: ${target}`);
          const where = {
            conversationId: member.conversationId,
            sequence: { gt: member.agentReadThroughSequence },
            sender: { userId: { not: null } },
          } as const;
          const count = await tx.message.count({ where });
          if (!count) continue;
          unreadSummary[target] = count;
          const budget = AGENT_RECOVERY_MESSAGE_LIMIT - resumeMessages.length;
          if (!budget) continue;
          const messages = await tx.message.findMany({
            where,
            orderBy: { sequence: "asc" },
            take: budget,
            select: {
              id: true,
              sequence: true,
              deliveries: { where: { agentId }, select: { deliveryId: true }, take: 1 },
            },
          });
          for (const message of messages) {
            const delivery = message.deliveries[0];
            if (!delivery) throw new Error(`Unread Agent message has no delivery: ${message.id}`);
            resumeMessages.push({
              messageId: message.id,
              deliveryId: delivery.deliveryId,
              conversationId: member.conversationId,
              sequence: message.sequence,
              target,
              latestSender: target,
            });
          }
        }
        return { resumeMessages, unreadSummary };
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  async readPendingAgentContext(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ) {
    const userId = await this.userIdForUsername(target);
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const agentMember = await this.db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId: conversation.id, agentId } },
      select: { id: true },
    });
    const latestAgentMessage =
      afterSequence === undefined && agentMember
        ? await this.db.message.findFirst({
            where: { conversationId: conversation.id, senderMemberId: agentMember.id },
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          })
        : undefined;
    const boundary = afterSequence ?? latestAgentMessage?.sequence ?? 0;
    const rows = await this.db.message.findMany({
      where: {
        conversationId: conversation.id,
        sequence: { gt: boundary },
        sender: { userId: { not: null } },
      },
      orderBy: { sequence: "desc" },
      take: 3,
      include: { sender: { include: { agent: true } }, attachment: true },
    });
    return rows.reverse().map((m) => ({
      id: m.id,
      sequence: m.sequence,
      sender: target,
      body: m.body,
      createdAt: m.createdAt,
      target,
      attachment: m.attachment ?? undefined,
    }));
  }

  async sendAgentMessage(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentId?: string,
  ) {
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      include: { members: true },
    });
    if (!conversation) throw new Error("conversation scope is not authorized");
    const sender = conversation.members.find((m) => m.agentId === agentId);
    const user = conversation.members.find((m) => m.userId);
    if (!sender || !user) throw new Error("agent is not a conversation member");
    const result = await this.db.$transaction(async (tx) => {
      // Serialize sequence allocators for this conversation before observing MAX(sequence).
      await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
      const last = await tx.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const sequence = (last?.sequence ?? 0) + 1;
      return tx.message.create({
        data: {
          conversationId,
          workspaceId: conversation.workspaceId,
          senderMemberId: sender.id,
          body,
          attachment: attachmentId ? { connect: { id: attachmentId } } : undefined,
          sequence,
        },
        select: {
          id: true,
          body: true,
          createdAt: true,
          sequence: true,
          deliveries: { select: { deliveryId: true } },
          attachment: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } },
        },
      });
    });
    return {
      ...result,
      // Agent-originated messages must never be enqueued back to the sender.
      deliveryId: undefined,
      workspaceId: conversation.workspaceId,
      agentId,
      target: "",
      attachment: result.attachment ?? undefined,
    };
  }
}
