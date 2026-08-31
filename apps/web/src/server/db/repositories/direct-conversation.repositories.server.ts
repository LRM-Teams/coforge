import type { Prisma, PrismaClient } from "../../../../generated/client";

export type AttachmentMetadata = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

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
            agent: { select: { name: true } },
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
      await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
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

  async readMessages(workspaceId: string, agentId: string, target: string) {
    const userId = await this.userIdForUsername(target);
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const rows = await this.db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { sequence: "asc" },
      include: { sender: { include: { agent: true } }, attachment: true },
    });
    return rows.map((m) => ({
      id: m.id,
      sequence: m.sequence,
      sender: m.sender.agentId ? `@${m.sender.agent?.name ?? "agent"}` : target,
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
      await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
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
