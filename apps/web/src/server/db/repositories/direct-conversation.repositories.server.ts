import { lockConversation } from "../../conversations/conversation-lock.server";
import type { MessageTaskMetadata, TaskStatus } from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "../../../../generated/client";
import { AgentMessageValidationError } from "../../conversations/agent-message-validation-error.server";
import { getAgentChannel, PublicChannels } from "../../conversations/public-channels.server";
import { mentionedNames } from "../../conversations/mentions";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
} from "../../conversations/message-reactions.server";
import { workspaceUserAvatarUrl } from "./user-profile.repositories.server";
import { attachmentView } from "../../attachments/attachment-view.server";

export type AttachmentMetadata = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Present only on the browser-facing shape; see `attachmentView`. Never set on the
   * Agent-facing shape (Agents keep the authenticated `/api/agent` proxy route). */
  previewUrl?: string;
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
    task?: MessageTaskMetadata;
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
/** Eight-hex-character prefix or a full UUID; both address a Message. */
const MESSAGE_ANCHOR =
  /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const ATTACHMENT_SELECT = {
  select: { id: true, fileName: true, contentType: true, sizeBytes: true, objectKey: true },
} satisfies Prisma.MessageSelect["attachment"];

/** Message projection sent to the browser client. */
const BROWSER_MESSAGE_SELECT = {
  id: true,
  sequence: true,
  threadRootId: true,
  body: true,
  createdAt: true,
  attachment: ATTACHMENT_SELECT,
  sender: {
    select: {
      userId: true,
      user: { select: { username: true, avatarObjectKey: true } },
      agent: { select: { name: true, displayName: true } },
    },
  },
  reactions: MESSAGE_REACTIONS_SELECT,
} satisfies Prisma.MessageSelect;

/** Just enough of the sender to render its `@handle`. */
const MESSAGE_SENDER_SELECT = {
  select: {
    agentId: true,
    agent: { select: { name: true } },
    user: { select: { username: true } },
  },
} satisfies NonNullable<Prisma.MessageInclude["sender"]>;

const TASK_METADATA_SELECT = {
  select: {
    number: true,
    status: true,
    owner: {
      select: {
        user: { select: { username: true, displayName: true } },
        agent: { select: { name: true, displayName: true } },
      },
    },
  },
} satisfies NonNullable<Prisma.MessageInclude["task"]>;

/** Message projection sent to an Agent. */
const AGENT_MESSAGE_INCLUDE = {
  sender: MESSAGE_SENDER_SELECT,
  attachment: true,
  task: TASK_METADATA_SELECT,
} satisfies Prisma.MessageInclude;

type DirectConversationMessageRow = Prisma.MessageGetPayload<{
  include: typeof AGENT_MESSAGE_INCLUDE;
}>;

type BrowserMessageRow = Prisma.MessageGetPayload<{ select: typeof BROWSER_MESSAGE_SELECT }>;

/** A delivery target is the conversation target, suffixed with the thread root when replying. */
function deliveryTarget(parent: string, rootId?: string | null) {
  if (!rootId) return parent;
  return `${parent}:${rootId}`;
}

/** `#channel` for a public channel, otherwise `@username` of the conversation's user member. */
function conversationTarget(conversation: {
  channelName: string | null;
  members: { user: { username: string } | null }[];
}) {
  return conversation.channelName
    ? `#${conversation.channelName}`
    : `@${conversation.members[0]?.user?.username}`;
}

function agentSenderHandle(
  sender: {
    agentId: string | null;
    agent: { name: string } | null;
    user: { username: string } | null;
  } | null,
) {
  if (!sender) return "system";
  return sender.agentId ? `@${sender.agent?.name ?? "agent"}` : `@${sender.user?.username}`;
}

function toAgentMessage(
  row: Pick<DirectConversationMessageRow, "id" | "sequence" | "body" | "createdAt"> & {
    sender: Parameters<typeof agentSenderHandle>[0];
    task: Parameters<typeof messageTask>[0];
    attachment?: AttachmentMetadata | null;
  },
  target: string,
) {
  const task = messageTask(row.task);
  return {
    id: row.id,
    sequence: row.sequence,
    sender: agentSenderHandle(row.sender),
    body: row.body,
    createdAt: row.createdAt,
    target,
    ...(row.attachment ? { attachment: row.attachment } : {}),
    ...(task ? { task } : {}),
  };
}

function toBrowserMessage(message: BrowserMessageRow, workspaceId: string) {
  return {
    id: message.id,
    sequence: message.sequence,
    threadRootId: message.threadRootId ?? undefined,
    senderKind: !message.sender
      ? ("system" as const)
      : message.sender.userId
        ? ("user" as const)
        : ("agent" as const),
    senderName: !message.sender
      ? "System"
      : message.sender.userId
        ? `@${message.sender.user?.username}`
        : message.sender.agent?.displayName || message.sender.agent?.name || "Agent",
    senderAvatarUrl: message.sender?.userId
      ? workspaceUserAvatarUrl(
          workspaceId,
          message.sender.userId,
          message.sender.user?.avatarObjectKey ?? null,
        )
      : null,
    body: message.body,
    createdAt: message.createdAt,
    attachment: message.attachment ? attachmentView(message.attachment) : undefined,
    reactions: reactionSummaries(message.reactions),
  };
}

/** Messages an Agent has not yet consumed: from users, or system messages delivered to it. */
function unreadForAgentWhere(agentId: string, isChannel: boolean) {
  return {
    OR: [
      { sender: { userId: { not: null } } },
      { senderMemberId: null, deliveries: { some: { agentId } } },
    ],
    ...(isChannel ? { deliveries: { some: { agentId } } } : {}),
  } satisfies Prisma.MessageWhereInput;
}

/**
 * Messages the Agent owes attention to: above its per-target read boundary, sent by a user, or
 * system-authored with a delivery row for this Agent; channels only count with a delivery row.
 * Shared by `readAgentRecoveryContext` and `drainAgentEvents` so the rule cannot drift between them.
 */
function unreadAgentMessagesFragment(workspaceId: string, agentId: string) {
  return Prisma.sql`
    SELECT m."id", m."sequence", m."body", m."conversationId", m."threadRootId",
      m."senderMemberId", COALESCE(r."sequence", 0) AS "rootSequence",
      d."deliveryId", su."username" AS "senderUsername", c."channelName",
      (SELECT uu."username" FROM "conversation_members" um
        JOIN "users" uu ON uu."id" = um."userId"
        WHERE um."conversationId" = c."id" ORDER BY uu."username" LIMIT 1) AS "userUsername"
    FROM "messages" m
    JOIN "conversation_members" am ON am."conversationId" = m."conversationId"
      AND am."workspaceId" = ${workspaceId}::uuid AND am."agentId" = ${agentId}::uuid
    JOIN "conversations" c ON c."id" = m."conversationId"
    LEFT JOIN "messages" r ON r."id" = m."threadRootId"
    LEFT JOIN "thread_reads" tr ON tr."memberId" = am."id" AND tr."rootMessageId" = m."threadRootId"
    LEFT JOIN "conversation_members" sm ON sm."id" = m."senderMemberId"
    LEFT JOIN "users" su ON su."id" = sm."userId"
    LEFT JOIN "agent_message_deliveries" d ON d."messageId" = m."id" AND d."agentId" = ${agentId}::uuid
    WHERE m."sequence" > CASE WHEN m."threadRootId" IS NULL
        THEN am."agentReadThroughSequence" ELSE COALESCE(tr."readThroughSequence", 0) END
      AND (sm."userId" IS NOT NULL OR (m."senderMemberId" IS NULL AND d."deliveryId" IS NOT NULL))
      AND (c."channelName" IS NULL OR d."deliveryId" IS NOT NULL)`;
}

/** Next sequence for a conversation; holds the conversation row lock until the transaction ends. */
async function allocateSequence(tx: Prisma.TransactionClient, conversationId: string) {
  await lockConversation(tx, conversationId);
  const last = await tx.message.findFirst({
    where: { conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return (last?.sequence ?? 0) + 1;
}

type AgentRecoveryRow = {
  id: string;
  sequence: number;
  body: string;
  conversationId: string;
  threadRootId: string | null;
  senderMemberId: string | null;
  deliveryId: string | null;
  senderUsername: string | null;
  channelName: string | null;
  userUsername: string | null;
  unreadCount: number;
  globalRank: number;
};

function taskStatus(value: string): TaskStatus {
  switch (value) {
    case "todo":
    case "in_progress":
    case "in_review":
    case "done":
    case "closed":
      return value;
    default:
      throw new Error("invalid persisted Task status");
  }
}

function messageTask(
  task: {
    number: number;
    status: string;
    owner: {
      user: { username: string; displayName: string | null } | null;
      agent: { name: string; displayName: string } | null;
    } | null;
  } | null,
): MessageTaskMetadata | undefined {
  if (!task) return undefined;
  const identity = task.owner?.agent ?? task.owner?.user;
  const handle = task.owner?.agent ? `@${task.owner.agent.name}` : `@${task.owner?.user?.username}`;
  return {
    number: task.number,
    status: taskStatus(task.status),
    ...(identity ? { owner: { displayName: identity.displayName || handle, handle } } : {}),
  };
}

export type DirectConversationRepository = {
  userIdForUsername?(target: string): Promise<string>;
  getAgentChannel?(workspaceId: string, agentId: string, target: string): Promise<{ id: string }>;
  resolveAgentTarget?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{
    conversationId: string;
    threadRootId: string | null;
    canonicalTarget: string;
    isChannel: boolean;
  }>;
  setAgentThreadFollowed?(
    workspaceId: string,
    agentId: string,
    target: string,
    followed: boolean,
  ): Promise<{ followed: boolean }>;
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
      task?: MessageTaskMetadata;
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
  resolveAgentMessage?(
    workspaceId: string,
    agentId: string,
    anchor: string,
  ): Promise<{
    id: string;
    sequence: number;
    sender: string;
    body: string;
    createdAt: Date;
    target: string;
    attachment?: AttachmentMetadata;
    task?: MessageTaskMetadata;
  }>;
  setAgentMessageReaction?(
    workspaceId: string,
    agentId: string,
    anchor: string,
    emoji: string,
    active: boolean,
  ): Promise<{ messageId: string }>;
  readPendingAgentContext?(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ): ReturnType<NonNullable<DirectConversationRepository["readMessages"]>>;
  /** Same pending-context scope as `readPendingAgentContext`, but a count rather than a bounded row window. */
  countPendingAgentContext?(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ): Promise<number>;
  readAgentRecoveryContext?(workspaceId: string, agentId: string): Promise<AgentRecoveryContext>;
  drainAgentEvents?(
    workspaceId: string,
    agentId: string,
    limit?: number,
  ): Promise<{
    messages: {
      id: string;
      sequence: number;
      sender: string;
      body: string;
      createdAt: Date;
      target: string;
      attachment?: AttachmentMetadata;
      task?: MessageTaskMetadata;
    }[];
    hasMore: boolean;
  }>;
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
      senderKind: "user" | "agent" | "system";
      senderName: string;
      senderAvatarUrl?: string | null;
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
      (root !== undefined && !MESSAGE_ANCHOR.test(root))
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
    if (!MESSAGE_ANCHOR.test(anchor))
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

  getAgentChannel(workspaceId: string, agentId: string, target: string) {
    return getAgentChannel(this.db, workspaceId, agentId, target);
  }

  setAgentChannelMuted(workspaceId: string, agentId: string, target: string, muted: boolean) {
    return new PublicChannels(this.db).setAgentMuted(workspaceId, agentId, target, muted);
  }

  setAgentThreadFollowed(workspaceId: string, agentId: string, target: string, followed: boolean) {
    return new PublicChannels(this.db).setAgentThreadFollowed(
      workspaceId,
      agentId,
      target,
      followed,
    );
  }

  /**
   * Resolve an Agent-facing target (`#channel` or `@user`, optionally `:root` for a thread)
   * to its conversation, thread root and canonical spelling. Public so other Agent HTTP routes
   * (e.g. attachment upload) can reuse the same target grammar instead of duplicating it.
   */
  async resolveAgentTarget(workspaceId: string, agentId: string, target: string) {
    const parentTarget = target.split(":")[0]!;
    const isChannel = parentTarget.startsWith("#");
    const conversation = isChannel
      ? await this.getAgentChannel(workspaceId, agentId, parentTarget)
      : await this.getOrCreateUserAgent(workspaceId, await this.userIdForUsername(target), agentId);
    const threadRootId = await this.targetRoot(conversation.id, target);
    return {
      conversationId: conversation.id,
      threadRootId,
      canonicalTarget: deliveryTarget(parentTarget, threadRootId),
      isChannel,
    };
  }

  async searchMessages(workspaceId: string, agentId: string, options: AgentMessageSearchOptions) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const scope = options.target
      ? await this.resolveAgentTarget(workspaceId, agentId, options.target)
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
          ...(scope ? { id: scope.conversationId } : {}),
        },
        ...(scope && options.target?.includes(":") ? { threadRootId: scope.threadRootId } : {}),
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
        sender: MESSAGE_SENDER_SELECT,
        task: TASK_METADATA_SELECT,
        conversation: {
          include: {
            members: {
              where: { userId: { not: null } },
              select: { user: { select: { username: true } } },
              take: 1,
            },
          },
        },
      },
    });
    return rows.map((message) =>
      toAgentMessage(
        message,
        deliveryTarget(conversationTarget(message.conversation), message.threadRootId),
      ),
    );
  }

  /** Looks a Message up by anchor across every conversation the Agent is a member of. */
  private async resolveAgentScopedMessage(workspaceId: string, agentId: string, anchor: string) {
    if (!MESSAGE_ANCHOR.test(anchor))
      throw new AgentMessageValidationError(
        "message anchor must be eight hexadecimal characters or a full UUID",
      );
    const rows = await this.db.message.findMany({
      where: {
        workspaceId,
        conversation: { members: { some: { agentId } } },
        id:
          anchor.length === 8
            ? {
                gte: `${anchor}-0000-0000-0000-000000000000`,
                lte: `${anchor}-ffff-ffff-ffff-ffffffffffff`,
              }
            : anchor,
      },
      take: 2,
      include: {
        sender: MESSAGE_SENDER_SELECT,
        task: TASK_METADATA_SELECT,
        conversation: {
          include: {
            members: {
              where: { userId: { not: null } },
              select: { user: { select: { username: true } } },
              take: 1,
            },
          },
        },
      },
    });
    if (rows.length > 1)
      throw new AgentMessageValidationError("ambiguous message prefix; use the full UUID");
    const row = rows[0];
    if (!row)
      throw new AgentMessageValidationError("message not found or not visible to this Agent");
    return row;
  }

  async resolveAgentMessage(workspaceId: string, agentId: string, anchor: string) {
    const row = await this.resolveAgentScopedMessage(workspaceId, agentId, anchor);
    return toAgentMessage(
      row,
      deliveryTarget(conversationTarget(row.conversation), row.threadRootId),
    );
  }

  async setAgentMessageReaction(
    workspaceId: string,
    agentId: string,
    anchor: string,
    emoji: string,
    active: boolean,
  ) {
    const row = await this.resolveAgentScopedMessage(workspaceId, agentId, anchor);
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId: row.conversationId, workspaceId, agentId },
      select: { id: true },
    });
    if (!member)
      throw new AgentMessageValidationError("message not found or not visible to this Agent");
    if (active)
      await this.db.messageReaction.upsert({
        where: { messageId_memberId_emoji: { messageId: row.id, memberId: member.id, emoji } },
        create: {
          messageId: row.id,
          conversationId: row.conversationId,
          workspaceId,
          memberId: member.id,
          emoji,
        },
        update: {},
      });
    else
      await this.db.messageReaction.deleteMany({
        where: { messageId: row.id, memberId: member.id, emoji },
      });
    return { messageId: row.id };
  }

  private async advanceThreadRead(
    client: Prisma.TransactionClient | PrismaClient,
    memberId: string,
    conversationId: string,
    workspaceId: string,
    rootMessageId: string,
    sequence: number,
  ) {
    // PostgreSQL's atomic upsert preserves monotonic positions across backend replicas.
    await client.$executeRaw`INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
      VALUES (${memberId}::uuid, ${conversationId}::uuid, ${workspaceId}::uuid, ${rootMessageId}::uuid, ${sequence})
      ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
        GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`;
  }

  async getOrCreateUserAgent(workspaceId: string, userId: string, agentId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, workspace: { members: { some: { userId } } } },
      select: { id: true },
    });
    if (!agent) throw new Error("conversation scope is not authorized");
    const where = { workspaceId_directKey: { workspaceId, directKey: keyFor(userId, agentId) } };
    const existing = await this.db.conversation.findUnique({ where, select: { id: true } });
    if (existing) return existing;
    try {
      return await this.db.conversation.create({
        data: buildUserAgentConversationCreateInput(workspaceId, userId, agentId),
        select: { id: true },
      });
    } catch (error) {
      // A concurrent first open won the insert; reuse its conversation.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        return this.db.conversation.findUniqueOrThrow({ where, select: { id: true } });
      throw error;
    }
  }

  /** The ids a browser send needs, without reading any messages. */
  async memberForUser(workspaceId: string, userId: string, agentId: string) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const member = await this.db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: conversation.id, userId } },
      select: { id: true },
    });
    return { conversationId: conversation.id, senderMemberId: member.id };
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
            ...BROWSER_MESSAGE_SELECT,
            replies: { orderBy: { sequence: "asc" }, select: BROWSER_MESSAGE_SELECT },
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
      messages: messages.map((message) => toBrowserMessage(message, workspaceId)),
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
      select: BROWSER_MESSAGE_SELECT,
    });
    return messages.map((message) => toBrowserMessage(message, workspaceId));
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
    await this.advanceThreadRead(
      this.db,
      member.id,
      conversation.id,
      workspaceId,
      root.id,
      latest.sequence,
    );
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
      const sequence = await allocateSequence(tx, conversationId);
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
          attachment: ATTACHMENT_SELECT,
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
      deliveryTarget: deliveryTarget(`@${sender.user?.username}`, root?.id),
      attachment: message.attachment ? attachmentView(message.attachment) : undefined,
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
        conversation: {
          select: {
            channelName: true,
            members: {
              where: { userId: { not: null } },
              select: { user: { select: { username: true } } },
              take: 1,
            },
          },
        },
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
      const sender = delivery.message.sender
        ? `@${delivery.message.sender.user?.username ?? ""}`
        : "system";
      const target = deliveryTarget(
        conversationTarget(delivery.conversation),
        delivery.message.threadRootId,
      );
      if (sender !== "system" && !PUBLIC_USERNAME_TARGET.test(sender))
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
    const { conversationId, threadRootId, canonicalTarget, isChannel } =
      await this.resolveAgentTarget(workspaceId, agentId, target);
    const scope = {
      conversationId,
      threadRootId,
      ...(isChannel && page.throughSequence !== undefined
        ? { deliveries: { some: { agentId } } }
        : {}),
    };
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 100);
    if ([page.before, page.after, page.around].filter(Boolean).length > 1)
      throw new Error("use only one range anchor");
    const anchorId = page.before ?? page.after ?? page.around;
    const [agentMember, anchor] = await Promise.all([
      this.db.conversationMember.findUnique({
        where: { conversationId_agentId: { conversationId, agentId } },
        select: { id: true, agentReadThroughSequence: true },
      }),
      anchorId ? this.resolveMessage(conversationId, anchorId) : undefined,
    ]);
    if (!agentMember) throw new Error("Agent is not a conversation member");
    if (anchor && anchor.threadRootId !== threadRootId)
      throw new AgentMessageValidationError("message anchor is outside this target");
    const threadRead = threadRootId
      ? await this.db.threadRead.findUnique({
          where: {
            memberId_rootMessageId: { memberId: agentMember.id, rootMessageId: threadRootId },
          },
          select: { readThroughSequence: true },
        })
      : null;
    const readThrough = threadRootId
      ? (threadRead?.readThroughSequence ?? 0)
      : agentMember.agentReadThroughSequence;
    const include = AGENT_MESSAGE_INCLUDE;
    const map = (rows: DirectConversationMessageRow[]) =>
      rows.map((row) => toAgentMessage(row, canonicalTarget));
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
        this.db,
        agentMember.id,
        conversationId,
        workspaceId,
        threadRootId,
        agentReadThroughSequence,
      );
    } else if (agentReadThroughSequence) {
      await this.db.conversationMember.updateMany({
        where: {
          conversationId,
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
    // One statement over every unread message the Agent owes attention to, ranked globally by
    // (conversation, thread root, sequence). Rows past the resume budget are kept only for the
    // first message of each target so unreadSummary stays complete without a second pass.
    const rows = await this.db.$queryRaw<AgentRecoveryRow[]>`
      WITH unread AS (
        ${unreadAgentMessagesFragment(workspaceId, agentId)}
      ), ranked AS (
        SELECT u.*,
          (COUNT(*) OVER (PARTITION BY "conversationId", "threadRootId"))::int AS "unreadCount",
          (ROW_NUMBER() OVER (PARTITION BY "conversationId", "threadRootId" ORDER BY "sequence"))::int AS "targetRank",
          (ROW_NUMBER() OVER (ORDER BY "conversationId", "rootSequence", "sequence"))::int AS "globalRank"
        FROM unread u
      )
      SELECT "id", "sequence", "body", "conversationId", "threadRootId", "senderMemberId",
        "deliveryId", "senderUsername", "channelName", "userUsername", "unreadCount", "globalRank"
      FROM ranked
      WHERE "globalRank" <= ${AGENT_RECOVERY_MESSAGE_LIMIT} OR "targetRank" = 1
      ORDER BY "globalRank"`;
    const resumeMessages: AgentRecoveryContext["resumeMessages"] = [];
    const unreadSummary: Record<string, number> = {};
    for (const row of rows) {
      if (!row.channelName && !row.userUsername)
        throw new Error("Agent conversation has no public user target");
      const target = deliveryTarget(
        row.channelName ? `#${row.channelName}` : `@${row.userUsername}`,
        row.threadRootId,
      );
      unreadSummary[target] ??= row.unreadCount;
      if (row.globalRank > AGENT_RECOVERY_MESSAGE_LIMIT) continue;
      if (!row.deliveryId) throw new Error(`Unread Agent message has no delivery: ${row.id}`);
      resumeMessages.push({
        messageId: row.id,
        deliveryId: row.deliveryId,
        conversationId: row.conversationId,
        sequence: row.sequence,
        target,
        latestSender:
          row.senderMemberId === null
            ? "system"
            : `@${row.channelName ? row.senderUsername : row.userUsername}`,
        body: row.body,
      });
    }
    return { resumeMessages, unreadSummary };
  }

  /**
   * Drains up to `limit` messages the Agent still owes attention to, in global
   * `(conversation, thread root, sequence)` order, and advances its read boundary for exactly the
   * targets returned (ack-on-drain). Boundaries only move forward.
   */
  async drainAgentEvents(
    workspaceId: string,
    agentId: string,
    limit = 50,
  ): Promise<{ messages: ReturnType<typeof toAgentMessage>[]; hasMore: boolean }> {
    const bounded = Math.min(Math.max(limit, 1), 100);
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<Pick<AgentRecoveryRow, "id" | "conversationId" | "threadRootId" | "sequence">>
      >`
        WITH unread AS (
          ${unreadAgentMessagesFragment(workspaceId, agentId)}
        )
        SELECT "id", "conversationId", "threadRootId", "sequence"
        FROM unread
        ORDER BY "conversationId", "rootSequence", "sequence"
        LIMIT ${bounded + 1}`;
      const hasMore = rows.length > bounded;
      const page = rows.slice(0, bounded);
      if (page.length === 0) return { messages: [], hasMore: false };
      const messageRows = await tx.message.findMany({
        where: { id: { in: page.map((row) => row.id) } },
        include: {
          ...AGENT_MESSAGE_INCLUDE,
          conversation: {
            include: {
              members: {
                where: { userId: { not: null } },
                select: { user: { select: { username: true } } },
                take: 1,
              },
            },
          },
        },
      });
      const rowById = new Map(messageRows.map((row) => [row.id, row]));
      const messages = page.map((row) => {
        const message = rowById.get(row.id);
        if (!message) throw new Error(`drained Agent message is missing: ${row.id}`);
        return toAgentMessage(
          message,
          deliveryTarget(conversationTarget(message.conversation), message.threadRootId),
        );
      });
      const targetGroups = new Map<
        string,
        { conversationId: string; threadRootId: string | null; maxSequence: number }
      >();
      for (const row of page) {
        const key = `${row.conversationId}:${row.threadRootId ?? ""}`;
        const existing = targetGroups.get(key);
        if (!existing || row.sequence > existing.maxSequence)
          targetGroups.set(key, {
            conversationId: row.conversationId,
            threadRootId: row.threadRootId,
            maxSequence: row.sequence,
          });
      }
      const members = await tx.conversationMember.findMany({
        where: { agentId, conversationId: { in: [...new Set(page.map((r) => r.conversationId))] } },
        select: { id: true, conversationId: true },
      });
      const memberIdByConversation = new Map(members.map((m) => [m.conversationId, m.id]));
      for (const group of targetGroups.values()) {
        if (group.threadRootId) {
          const memberId = memberIdByConversation.get(group.conversationId);
          if (!memberId) throw new Error("Agent is not a conversation member");
          await this.advanceThreadRead(
            tx,
            memberId,
            group.conversationId,
            workspaceId,
            group.threadRootId,
            group.maxSequence,
          );
        } else {
          await tx.conversationMember.updateMany({
            where: {
              conversationId: group.conversationId,
              agentId,
              agentReadThroughSequence: { lt: group.maxSequence },
            },
            data: { agentReadThroughSequence: group.maxSequence },
          });
        }
      }
      return { messages, hasMore };
    });
  }

  async advanceAgentReadThrough(
    workspaceId: string,
    agentId: string,
    target: string,
    seenUpToSequence: number,
  ): Promise<number> {
    const { conversationId, threadRootId } = await this.resolveAgentTarget(
      workspaceId,
      agentId,
      target,
    );
    const latest = await this.db.message.findFirst({
      where: { conversationId, threadRootId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const bounded = Math.min(seenUpToSequence, latest?.sequence ?? 0);
    if (bounded && threadRootId) {
      const member = await this.db.conversationMember.findUniqueOrThrow({
        where: { conversationId_agentId: { conversationId, agentId } },
        select: { id: true },
      });
      await this.advanceThreadRead(
        this.db,
        member.id,
        conversationId,
        workspaceId,
        threadRootId,
        bounded,
      );
    } else if (bounded)
      await this.db.conversationMember.updateMany({
        where: {
          conversationId,
          workspaceId,
          agentId,
          agentReadThroughSequence: { lt: bounded },
        },
        data: { agentReadThroughSequence: bounded },
      });
    return bounded;
  }

  /**
   * Resolves the pending-agent-context scope (conversation/thread, unread boundary and `where`
   * clause) shared by `readPendingAgentContext` and `countPendingAgentContext`, so a bounded
   * read and its unbounded count cannot drift apart.
   */
  private async pendingAgentContextScope(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ) {
    const { conversationId, threadRootId, canonicalTarget, isChannel } =
      await this.resolveAgentTarget(workspaceId, agentId, target);
    const agentMember = await this.db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true },
    });
    const latestAgentMessage =
      afterSequence === undefined && agentMember
        ? await this.db.message.findFirst({
            where: {
              conversationId,
              threadRootId,
              senderMemberId: agentMember.id,
            },
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          })
        : undefined;
    const boundary = afterSequence ?? latestAgentMessage?.sequence ?? 0;
    return {
      canonicalTarget,
      where: {
        conversationId,
        threadRootId,
        sequence: { gt: boundary },
        ...unreadForAgentWhere(agentId, isChannel),
      } satisfies Prisma.MessageWhereInput,
    };
  }

  async readPendingAgentContext(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ) {
    const { canonicalTarget, where } = await this.pendingAgentContextScope(
      workspaceId,
      agentId,
      target,
      afterSequence,
    );
    const rows = await this.db.message.findMany({
      where,
      orderBy: { sequence: "desc" },
      take: 3,
      include: { sender: MESSAGE_SENDER_SELECT, attachment: true },
    });
    return rows.reverse().map((m) => ({
      id: m.id,
      sequence: m.sequence,
      sender: m.sender ? `@${m.sender.user?.username}` : "system",
      body: m.body,
      createdAt: m.createdAt,
      target: canonicalTarget,
      attachment: m.attachment ?? undefined,
    }));
  }

  /** Count of the same pending-agent-context scope `readPendingAgentContext` reads, unbounded by its 3-row window. */
  async countPendingAgentContext(
    workspaceId: string,
    agentId: string,
    target: string,
    afterSequence?: number,
  ) {
    const { where } = await this.pendingAgentContextScope(
      workspaceId,
      agentId,
      target,
      afterSequence,
    );
    return this.db.message.count({ where });
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
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
    const result = await this.db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      if (conversation.channelName && root) {
        const names = mentionedNames(body);
        const mentioned = await tx.conversationMember.findMany({
          where: {
            conversationId,
            OR: [{ user: { username: { in: names } } }, { agent: { name: { in: names } } }],
          },
          select: { id: true },
        });
        await tx.threadFollow.createMany({
          data: [sender.id, ...mentioned.map(({ id }) => id)].map((memberId) => ({
            memberId,
            rootMessageId: root.id,
            conversationId,
            workspaceId: conversation.workspaceId,
          })),
          skipDuplicates: true,
        });
      }
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
          attachment: ATTACHMENT_SELECT,
        },
      });
    });
    return {
      ...result,
      // Agent-originated messages must never be enqueued back to the sender.
      deliveryId: undefined,
      workspaceId: conversation.workspaceId,
      agentId,
      target: conversation.channelName
        ? deliveryTarget(`#${conversation.channelName}`, root?.id)
        : "",
      // Agent-facing shape: metadata only; the object key never leaves the backend.
      attachment: result.attachment
        ? {
            id: result.attachment.id,
            fileName: result.attachment.fileName,
            contentType: result.attachment.contentType,
            sizeBytes: result.attachment.sizeBytes,
          }
        : undefined,
    };
  }
}
