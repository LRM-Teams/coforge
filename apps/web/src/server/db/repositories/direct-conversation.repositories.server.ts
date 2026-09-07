import { Prisma, type PrismaClient } from "../../../../generated/client";
import { AgentMessageValidationError } from "../../conversations/agent-message-validation-error.server";
import { getAgentChannel, PublicChannels } from "../../conversations/public-channels.server";

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

export type AgentMessageSearchOptions = {
  query?: string;
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
};

export type AgentRecoveryContext = {
  resumeMessages: Array<{
    messageId: string;
    deliveryId: string;
    conversationId: string;
    sequence: number;
    target: string;
    latestSender: string;
    body: string;
  }>;
  unreadSummary: Readonly<Record<string, number>>;
};

export type PendingAgentDelivery = AgentRecoveryContext["resumeMessages"][number];

const AGENT_RECOVERY_MESSAGE_LIMIT = 100;
const PUBLIC_USERNAME_TARGET = /^@[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/;

type DirectConversationMessageRow = Prisma.MessageGetPayload<{
  include: {
    sender: { include: { agent: true; user: true } };
    attachment: true;
  };
}>;

export type DirectConversationRepository = {
  userIdForUsername?(target: string): Promise<string>;
  getAgentChannel?(workspaceId: string, agentId: string, target: string): Promise<{ id: string }>;
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
    threadRootId?: string,
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
    deliveryTarget?: string;
    attachment?: AttachmentMetadata;
  }>;
  receiveDeliveryAck?(input: {
    workspaceId: string;
    computerId: string;
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
  searchMessages?(
    workspaceId: string,
    agentId: string,
    options: AgentMessageSearchOptions,
  ): ReturnType<NonNullable<DirectConversationRepository["readMessages"]>>;
  readPendingAgentContext?(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ): ReturnType<NonNullable<DirectConversationRepository["readMessages"]>>;
  readAgentRecoveryContext?(workspaceId: string, agentId: string): Promise<AgentRecoveryContext>;
  readPendingAgentDeliveries?(
    workspaceId: string,
    agentId: string,
  ): Promise<PendingAgentDelivery[]>;
  advanceAgentReadThrough?(
    workspaceId: string,
    agentId: string,
    target: string,
    seenUpToSequence: number,
  ): Promise<number>;
  sendAgentMessage?(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentId?: string,
    threadRootId?: string,
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
    page?: { beforeSequence?: number; limit?: number },
  ): Promise<{
    conversationId: string;
    senderMemberId: string;
    threadReadThrough?: Record<string, number>;
    agent: { id: string; name: string; displayName: string };
    hasOlder: boolean;
    hasNewer?: boolean;
    messages: Array<{
      id: string;
      sequence: number;
      senderKind: "user" | "agent";
      senderName: string;
      body: string;
      createdAt: Date;
      threadRootId?: string;
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
    const [parentTarget, root, extra] = target.split(":");
    if (
      !PUBLIC_USERNAME_TARGET.test(parentTarget!) ||
      extra !== undefined ||
      (root !== undefined &&
        !/^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
          root,
        ))
    )
      throw new Error("invalid message target");
    const user = await this.db.user.findUnique({
      where: { username: parentTarget!.slice(1) },
      select: { id: true },
    });
    if (!user) throw new Error("target user not found");
    return user.id;
  }

  private async resolveMessage(conversationId: string, anchor: string, rootOnly = false) {
    if (
      !/^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(anchor)
    )
      throw new AgentMessageValidationError(
        "message anchor must be eight hexadecimal characters or a full UUID",
      );
    const rows = await this.db.message.findMany({
      where: {
        conversationId,
        id:
          anchor.length === 8
            ? {
                gte: `${anchor}-0000-0000-0000-000000000000`,
                lte: `${anchor}-ffff-ffff-ffff-ffffffffffff`,
              }
            : anchor,
      },
      take: 2,
      select: { id: true, sequence: true, threadRootId: true },
    });
    if (rows.length > 1)
      throw new AgentMessageValidationError("ambiguous message prefix; use the full UUID");
    const row = rows[0];
    if (!row)
      throw new AgentMessageValidationError("message anchor not found in this conversation");
    if (rootOnly && row.threadRootId)
      throw new AgentMessageValidationError("thread root must be a top-level message");
    return row;
  }

  private async targetRoot(conversationId: string, target: string) {
    const root = target.split(":")[1];
    return root ? (await this.resolveMessage(conversationId, root, true)).id : null;
  }

  private deliveryTarget(sender: string, rootId?: string | null) {
    if (!rootId) return sender;
    return `${sender}:${rootId}`;
  }

  getAgentChannel(workspaceId: string, agentId: string, target: string) {
    return getAgentChannel(this.db, workspaceId, agentId, target);
  }

  setAgentChannelMuted(workspaceId: string, agentId: string, target: string, muted: boolean) {
    return new PublicChannels(this.db).setAgentMuted(workspaceId, agentId, target, muted);
  }

  private async conversationForAgentTarget(workspaceId: string, agentId: string, target: string) {
    const parentTarget = target.split(":")[0]!;
    if (parentTarget.startsWith("#"))
      return this.getAgentChannel(workspaceId, agentId, parentTarget);
    const userId = await this.userIdForUsername(target);
    return this.getOrCreateUserAgent(workspaceId, userId, agentId);
  }

  async searchMessages(workspaceId: string, agentId: string, options: AgentMessageSearchOptions) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const conversation = options.target
      ? await this.conversationForAgentTarget(workspaceId, agentId, options.target)
      : undefined;
    const threadRootId =
      conversation && options.target
        ? await this.targetRoot(conversation.id, options.target)
        : undefined;
    const before = options.before ? new Date(options.before) : undefined;
    const after = options.after ? new Date(options.after) : undefined;
    if ((before && Number.isNaN(before.getTime())) || (after && Number.isNaN(after.getTime())))
      throw new Error("search dates must be ISO datetimes");
    const sender = options.sender?.replace(/^@/, "");
    const searchQuery = options.query
      ? (
          await this.db.$queryRaw<Array<{ query: string }>>(
            Prisma.sql`SELECT websearch_to_tsquery(${options.query})::text AS query`,
          )
        )[0]?.query
      : undefined;
    if (options.query && !searchQuery) return [];
    const orderBy = (
      searchQuery && options.sort !== "recent"
        ? [
            {
              _relevance: {
                fields: ["body"],
                search: searchQuery,
                sort: "desc",
              },
            },
            { createdAt: "desc" },
            { id: "desc" },
          ]
        : [{ createdAt: "desc" }, { id: "desc" }]
    ) satisfies Prisma.MessageOrderByWithRelationInput[];
    const rows = await this.db.message.findMany({
      where: {
        workspaceId,
        conversation: {
          members: { some: { agentId } },
          ...(conversation ? { id: conversation.id } : {}),
        },
        ...(conversation && options.target?.includes(":") ? { threadRootId } : {}),
        ...(searchQuery ? { body: { search: searchQuery } } : {}),
        ...(sender
          ? {
              sender: {
                OR: [{ user: { username: sender } }, { agent: { name: sender } }],
              },
            }
          : {}),
        ...(before || after
          ? {
              createdAt: {
                ...(before ? { lt: before } : {}),
                ...(after ? { gt: after } : {}),
              },
            }
          : {}),
      },
      orderBy,
      skip: offset,
      take: limit,
      include: {
        sender: { include: { agent: true, user: true } },
        conversation: {
          include: {
            members: {
              where: { userId: { not: null } },
              include: { user: true },
            },
          },
        },
      },
    });
    return rows.map((message) => {
      const parentTarget = message.conversation.channelName
        ? `#${message.conversation.channelName}`
        : `@${message.conversation.members[0]?.user?.username}`;
      return {
        id: message.id,
        sequence: message.sequence,
        sender: message.sender.agentId
          ? `@${message.sender.agent?.name ?? "agent"}`
          : `@${message.sender.user?.username}`,
        body: message.body,
        createdAt: message.createdAt,
        target: this.deliveryTarget(parentTarget, message.threadRootId),
      };
    });
  }

  private async advanceThreadRead(
    memberId: string,
    conversationId: string,
    workspaceId: string,
    rootMessageId: string,
    sequence: number,
  ) {
    // PostgreSQL's atomic upsert preserves monotonic positions across backend replicas.
    await this.db.$executeRaw`INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
      VALUES (${memberId}::uuid, ${conversationId}::uuid, ${workspaceId}::uuid, ${rootMessageId}::uuid, ${sequence})
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
        GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`;
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

  async openForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    page: { beforeSequence?: number; limit?: number } = {},
  ) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const limit = Math.min(page.limit ?? 50, 100);
    const row = await this.db.conversation.findUnique({
      where: { id: conversation.id },
      select: {
        members: {
          select: {
            id: true,
            userId: true,
            agentId: true,
            threadReads: {
              select: { rootMessageId: true, readThroughSequence: true },
            },
            user: { select: { username: true } },
            agent: { select: { id: true, name: true, displayName: true } },
          },
        },
        messages: {
          where: {
            threadRootId: null,
            sequence: page.beforeSequence ? { lt: page.beforeSequence } : undefined,
          },
          orderBy: { sequence: "desc" },
          take: limit + 1,
          select: {
            id: true,
            sequence: true,
            threadRootId: true,
            body: true,
            createdAt: true,
            attachment: {
              select: {
                id: true,
                fileName: true,
                contentType: true,
                sizeBytes: true,
              },
            },
            sender: {
              select: {
                userId: true,
                user: { select: { username: true } },
                agent: { select: { name: true, displayName: true } },
              },
            },
            replies: {
              orderBy: { sequence: "asc" },
              select: {
                id: true,
                sequence: true,
                threadRootId: true,
                body: true,
                createdAt: true,
                attachment: {
                  select: {
                    id: true,
                    fileName: true,
                    contentType: true,
                    sizeBytes: true,
                  },
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
        },
      },
    });
    const sender = row?.members.find((member) => member.userId === userId);
    const agentMember = row?.members.find((member) => member.agentId === agentId);
    if (!row || !sender || !agentMember?.agent)
      throw new Error("conversation scope is not authorized");
    const hasOlder = row.messages.length > limit;
    const messages = row.messages
      .slice(0, limit)
      .reverse()
      .flatMap((message) => [message, ...message.replies])
      .sort((left, right) => left.sequence - right.sequence);
    return {
      conversationId: conversation.id,
      senderMemberId: sender.id,
      threadReadThrough: Object.fromEntries(
        sender.threadReads.map((r) => [r.rootMessageId, r.readThroughSequence]),
      ),
      agent: agentMember.agent,
      hasOlder,
      hasNewer: false,
      messages: messages.map((message) => ({
        id: message.id,
        sequence: message.sequence,
        threadRootId: message.threadRootId ?? undefined,
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

  async updatesForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    afterSequence: number,
  ) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const messages = await this.db.message.findMany({
      where: {
        conversationId: conversation.id,
        sequence: { gt: afterSequence },
      },
      orderBy: { sequence: "asc" },
      take: 100,
      select: {
        id: true,
        sequence: true,
        threadRootId: true,
        body: true,
        createdAt: true,
        attachment: {
          select: {
            id: true,
            fileName: true,
            contentType: true,
            sizeBytes: true,
          },
        },
        sender: {
          select: {
            userId: true,
            user: { select: { username: true } },
            agent: { select: { name: true, displayName: true } },
          },
        },
      },
    });
    return messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      threadRootId: message.threadRootId ?? undefined,
      senderKind: message.sender.userId ? ("user" as const) : ("agent" as const),
      senderName: message.sender.userId
        ? `@${message.sender.user?.username}`
        : message.sender.agent?.displayName || message.sender.agent?.name || "Agent",
      body: message.body,
      createdAt: message.createdAt,
      attachment: message.attachment ?? undefined,
    }));
  }

  async markThreadReadForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    rootMessageId: string,
    throughSequence: number,
  ) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const root = await this.resolveMessage(conversation.id, rootMessageId, true);
    const latest = await this.db.message.findFirst({
      where: {
        conversationId: conversation.id,
        threadRootId: root.id,
        sequence: { lte: throughSequence },
      },
      orderBy: { sequence: "desc" },
    });
    if (!latest) return;
    const member = await this.db.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_userId: { conversationId: conversation.id, userId },
      },
    });
    await this.advanceThreadRead(member.id, conversation.id, workspaceId, root.id, latest.sequence);
  }

  async sendMessage(
    conversationId: string,
    senderMemberId: string,
    senderUserId: string,
    body: string,
    attachmentId?: string,
    threadRootId?: string,
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
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
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
          threadRootId: root?.id,
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
          attachment: {
            select: {
              id: true,
              fileName: true,
              contentType: true,
              sizeBytes: true,
            },
          },
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
      deliveryTarget: this.deliveryTarget(`@${sender.user?.username}`, root?.id),
      attachment: message.attachment ?? undefined,
    };
  }

  async receiveDeliveryAck(input: {
    workspaceId: string;
    computerId: string;
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
        agent: { computerId: input.computerId },
      },
      data: { receivedAt: new Date() },
    });
    if (result.count !== 1) throw new Error("delivery acknowledgement is not authorized");
  }

  async readPendingAgentDeliveries(
    workspaceId: string,
    agentId: string,
  ): Promise<PendingAgentDelivery[]> {
    const deliveries = await this.db.agentMessageDelivery.findMany({
      where: { workspaceId, agentId, receivedAt: null },
      orderBy: [{ createdAt: "asc" }, { deliveryId: "asc" }],
      select: {
        deliveryId: true,
        messageId: true,
        conversationId: true,
        conversation: { select: { channelName: true } },
        sequence: true,
        message: {
          select: {
            body: true,
            threadRootId: true,
            sender: { select: { user: { select: { username: true } } } },
          },
        },
      },
    });
    return deliveries.map((delivery) => {
      const sender = `@${delivery.message.sender.user?.username ?? ""}`;
      const target = delivery.conversation.channelName
        ? `#${delivery.conversation.channelName}`
        : this.deliveryTarget(sender, delivery.message.threadRootId);
      if (!PUBLIC_USERNAME_TARGET.test(sender))
        throw new Error("pending Agent delivery sender must be a public @username");
      return {
        messageId: delivery.messageId,
        deliveryId: delivery.deliveryId,
        conversationId: delivery.conversationId,
        sequence: delivery.sequence,
        target,
        latestSender: sender,
        body: delivery.message.body,
      };
    });
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
    const conversation = await this.conversationForAgentTarget(workspaceId, agentId, target);
    const threadRootId = await this.targetRoot(conversation.id, target);
    const canonicalTarget = this.deliveryTarget(target.split(":")[0]!, threadRootId);
    const scope = {
      conversationId: conversation.id,
      threadRootId,
      ...(target.startsWith("#") && page.throughSequence !== undefined
        ? { deliveries: { some: { agentId } } }
        : {}),
    };
    const agentMember = await this.db.conversationMember.findFirst({
      where: { conversationId: conversation.id, agentId },
      select: { id: true, agentReadThroughSequence: true },
    });
    if (!agentMember) throw new Error("Agent is not a conversation member");
    const threadRead = threadRootId
      ? await this.db.threadRead.findUnique({
          where: {
            memberId_rootMessageId: {
              memberId: agentMember.id,
              rootMessageId: threadRootId,
            },
          },
        })
      : null;
    const readThrough = threadRootId
      ? (threadRead?.readThroughSequence ?? 0)
      : agentMember.agentReadThroughSequence;
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 100);
    if ([page.before, page.after, page.around].filter(Boolean).length > 1)
      throw new Error("use only one range anchor");
    const anchor =
      (page.before ?? page.after ?? page.around)
        ? await this.resolveMessage(conversation.id, (page.before ?? page.after ?? page.around)!)
        : undefined;
    if (anchor && anchor.threadRootId !== threadRootId)
      throw new AgentMessageValidationError("message anchor is outside this target");
    const include = {
      sender: { include: { agent: true, user: true } },
      attachment: true,
    } as const;
    const map = (rows: DirectConversationMessageRow[]) =>
      rows.map((m) => ({
        id: m.id,
        sequence: m.sequence,
        sender: m.sender.agentId
          ? `@${m.sender.agent?.name ?? "agent"}`
          : `@${m.sender.user?.username}`,
        body: m.body,
        createdAt: m.createdAt,
        target: canonicalTarget,
        attachment: m.attachment ?? undefined,
      }));
    if (page.around && anchor) {
      const beforeCount = Math.floor((limit - 1) / 2);
      const afterCount = limit - 1 - beforeCount;
      const [beforeRows, anchorRows, afterRows] = await Promise.all([
        this.db.message.findMany({
          where: { ...scope, sequence: { lt: anchor.sequence } },
          orderBy: { sequence: "desc" },
          take: beforeCount + 1,
          include,
        }),
        this.db.message.findMany({
          where: { ...scope, sequence: anchor.sequence },
          take: 1,
          include,
        }),
        this.db.message.findMany({
          where: { ...scope, sequence: { gt: anchor.sequence } },
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
      : (page.fromSequence ?? readThrough + 1);
    const effectiveSequence = {
      ...(effectiveFromSequence !== undefined ? { gte: effectiveFromSequence } : {}),
      ...(page.throughSequence !== undefined ? { lte: page.throughSequence } : {}),
      ...(anchor && page.before ? { lt: anchor.sequence } : {}),
      ...(anchor && page.after ? { gt: anchor.sequence } : {}),
    };
    const rows = await this.db.message.findMany({
      where: {
        ...scope,
        ...(Object.keys(effectiveSequence).length ? { sequence: effectiveSequence } : {}),
      },
      orderBy: { sequence: page.before ? "desc" : "asc" },
      take: limit + 1,
      include,
    });
    const hasMore = rows.length > limit;
    const messages = map(rows.slice(0, limit).sort((a, b) => a.sequence - b.sequence));
    const isBoundaryRead = !isHistoryRead && effectiveFromSequence === readThrough + 1;
    const agentReadThroughSequence = isBoundaryRead ? (messages.at(-1)?.sequence ?? 0) : 0;
    if (agentReadThroughSequence && threadRootId) {
      await this.advanceThreadRead(
        agentMember.id,
        conversation.id,
        workspaceId,
        threadRootId,
        agentReadThroughSequence,
      );
    } else if (agentReadThroughSequence) {
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
            threadReads: {
              select: { rootMessageId: true, readThroughSequence: true },
            },
            conversation: {
              select: {
                channelName: true,
                messages: {
                  where: { replies: { some: {} } },
                  select: { id: true },
                  orderBy: { sequence: "asc" },
                },
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
          const channelName = member.conversation.channelName;
          const username = member.conversation.members[0]?.user?.username;
          if (!channelName && !username)
            throw new Error("Agent conversation has no public user target");
          const roots: (string | null)[] = [
            null,
            ...(member.conversation.messages ?? []).map((m) => m.id),
          ];
          for (const threadRootId of roots) {
            const target = this.deliveryTarget(
              channelName ? `#${channelName}` : `@${username}`,
              threadRootId,
            );
            if (target in unreadSummary)
              throw new Error(`duplicate Agent recovery target: ${target}`);
            const boundary = threadRootId
              ? (member.threadReads.find((r) => r.rootMessageId === threadRootId)
                  ?.readThroughSequence ?? 0)
              : member.agentReadThroughSequence;
            const where = {
              conversationId: member.conversationId,
              threadRootId,
              sequence: { gt: boundary },
              sender: { userId: { not: null } },
              ...(channelName ? { deliveries: { some: { agentId } } } : {}),
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
                body: true,
                sender: { select: { user: { select: { username: true } } } },
                deliveries: {
                  where: { agentId },
                  select: { deliveryId: true },
                  take: 1,
                },
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
                latestSender: channelName ? `@${message.sender.user?.username}` : `@${username}`,
                body: message.body,
              });
            }
          }
        }
        return { resumeMessages, unreadSummary };
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  async advanceAgentReadThrough(
    workspaceId: string,
    agentId: string,
    target: string,
    seenUpToSequence: number,
  ): Promise<number> {
    const conversation = await this.conversationForAgentTarget(workspaceId, agentId, target);
    const threadRootId = await this.targetRoot(conversation.id, target);
    const latest = await this.db.message.findFirst({
      where: { conversationId: conversation.id, threadRootId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const bounded = Math.min(seenUpToSequence, latest?.sequence ?? 0);
    if (bounded && threadRootId) {
      const member = await this.db.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_agentId: { conversationId: conversation.id, agentId },
        },
      });
      await this.advanceThreadRead(member.id, conversation.id, workspaceId, threadRootId, bounded);
    } else if (bounded)
      await this.db.conversationMember.updateMany({
        where: {
          conversationId: conversation.id,
          workspaceId,
          agentId,
          agentReadThroughSequence: { lt: bounded },
        },
        data: { agentReadThroughSequence: bounded },
      });
    return bounded;
  }

  async readPendingAgentContext(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ) {
    const conversation = await this.conversationForAgentTarget(workspaceId, agentId, target);
    const threadRootId = await this.targetRoot(conversation.id, target);
    const canonicalTarget = this.deliveryTarget(target.split(":")[0]!, threadRootId);
    const agentMember = await this.db.conversationMember.findUnique({
      where: {
        conversationId_agentId: { conversationId: conversation.id, agentId },
      },
      select: { id: true },
    });
    const latestAgentMessage =
      afterSequence === undefined && agentMember
        ? await this.db.message.findFirst({
            where: {
              conversationId: conversation.id,
              threadRootId,
              senderMemberId: agentMember.id,
            },
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          })
        : undefined;
    const boundary = afterSequence ?? latestAgentMessage?.sequence ?? 0;
    const rows = await this.db.message.findMany({
      where: {
        conversationId: conversation.id,
        threadRootId,
        sequence: { gt: boundary },
        sender: { userId: { not: null } },
        ...(target.startsWith("#") ? { deliveries: { some: { agentId } } } : {}),
      },
      orderBy: { sequence: "desc" },
      take: 3,
      include: {
        sender: { include: { agent: true, user: true } },
        attachment: true,
      },
    });
    return rows.reverse().map((m) => ({
      id: m.id,
      sequence: m.sequence,
      sender: `@${m.sender.user?.username}`,
      body: m.body,
      createdAt: m.createdAt,
      target: canonicalTarget,
      attachment: m.attachment ?? undefined,
    }));
  }

  async sendAgentMessage(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentId?: string,
    threadRootId?: string,
  ) {
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      include: { members: true },
    });
    if (!conversation) throw new Error("conversation scope is not authorized");
    const sender = conversation.members.find((m) => m.agentId === agentId);
    const user = conversation.members.find((m) => m.userId);
    if (!sender || (!conversation.channelName && !user))
      throw new Error("agent is not a conversation member");
    if (conversation.channelName && threadRootId)
      throw new Error("channel threads are not supported");
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
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
          threadRootId: root?.id,
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
          attachment: {
            select: {
              id: true,
              fileName: true,
              contentType: true,
              sizeBytes: true,
            },
          },
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
