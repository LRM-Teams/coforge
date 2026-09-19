import { lockConversation } from "../../conversations/conversation-lock.server";
import type { MessageTaskMetadata, TaskStatus } from "@lrm/coforge-sdk/internal";
import { normalizeMentionBody } from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "../../../../generated/client";
import { AppError } from "../../../lib/app-error";
import { AgentMessageValidationError } from "../../conversations/agent-message-validation-error.server";
import { getAgentChannel, PublicChannels } from "../../conversations/public-channels.server";
import { ACTIVE_MEMBER_WHERE } from "../../conversations/active-member.server";
import {
  agentReadableBody,
  BROWSER_MESSAGE_MENTIONS_SELECT,
  browserMessageMention,
  mentionedNames,
} from "../../conversations/mentions";
import { AgentSendRejectedError } from "../../conversations/agent-send-rejected-error.server";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
} from "../../conversations/message-reactions.server";
import { browserSenderHandle, browserSenderName } from "../../conversations/sender-display.server";
import { workspaceUserAvatarUrl } from "./user-profile.repositories.server";
import { attachmentView } from "../../attachments/attachment-view.server";
import type { ActionCardView } from "../../conversations/action-cards.server";

export type AgentMentionBinding = { type: "user" | "agent"; id: string; name: string };

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
    /** Always present, possibly empty; order matches send/upload order. */
    attachments: AttachmentMetadata[];
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

/** Per-message attachment projection, ordered by stable send/upload position. */
const ATTACHMENT_SELECT = {
  select: { id: true, fileName: true, contentType: true, sizeBytes: true, objectKey: true },
  orderBy: { position: "asc" },
} satisfies Prisma.MessageSelect["attachments"];

/** Stable mention identity for Agent-facing text; Agents always read the immutable handle. */
const MESSAGE_MENTIONS_SELECT = {
  select: { kind: true, actorId: true, handle: true },
} satisfies NonNullable<Prisma.MessageSelect["mentions"]>;

/** Message projection sent to the browser client. */
const BROWSER_MESSAGE_SELECT = {
  id: true,
  sequence: true,
  threadRootId: true,
  body: true,
  createdAt: true,
  attachments: ATTACHMENT_SELECT,
  sender: {
    select: {
      userId: true,
      agentId: true,
      user: { select: { username: true, displayName: true, avatarObjectKey: true } },
      agent: { select: { name: true, displayName: true, deletedAt: true } },
    },
  },
  mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
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

/** Just the state an Agent needs to know whether a card it prepared has been acted on. */
const ACTION_CARD_STATE_SELECT = {
  select: { state: true },
} satisfies NonNullable<Prisma.MessageInclude["actionCard"]>;

/** Message projection sent to an Agent. */
const AGENT_MESSAGE_INCLUDE = {
  sender: MESSAGE_SENDER_SELECT,
  attachments: { orderBy: { position: "asc" } },
  task: TASK_METADATA_SELECT,
  actionCard: ACTION_CARD_STATE_SELECT,
  mentions: MESSAGE_MENTIONS_SELECT,
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
    attachments: AttachmentMetadata[];
    actionCard?: { state: string } | null;
    mentions?: { kind: string; actorId: string; handle: string }[];
  },
  target: string,
) {
  const task = messageTask(row.task);
  // Agents read plain `@handle` text: the embedded-UUID token form is a storage/browser concern
  // and never crosses onto the Agent channel.
  const body = agentReadableBody(row.body, row.mentions ?? []);
  return {
    id: row.id,
    sequence: row.sequence,
    sender: agentSenderHandle(row.sender),
    // An Agent reads message text, not the browser card UI; append the card's current state so it
    // never claims a resource exists before a human has actually committed the card (ADR 0027).
    body: row.actionCard ? `${body} [action card: ${row.actionCard.state}]` : body,
    createdAt: row.createdAt,
    target,
    attachments: row.attachments,
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
    senderName: browserSenderName(message.sender),
    senderHandle: browserSenderHandle(message.sender),
    /** The sender's Agent id, present only for an Agent-sent message; opens the Agent profile
     * panel from a message row (`features/agents/profile-panel/`). */
    senderAgentId: message.sender?.agentId ?? undefined,
    /** True when the sending Agent has since been deleted (ADR 0044): the row renders its sender
     * greyed with a `DELETED` marker, and no longer opens that Agent's profile. */
    senderDeleted: Boolean(message.sender?.agent?.deletedAt),
    senderAvatarUrl: message.sender?.userId
      ? workspaceUserAvatarUrl(
          workspaceId,
          message.sender.userId,
          message.sender.user?.avatarObjectKey ?? null,
        )
      : null,
    body: message.body,
    createdAt: message.createdAt,
    mentions: message.mentions.map(browserMessageMention),
    attachments: message.attachments.map((attachment) => attachmentView(attachment)),
    reactions: reactionSummaries(message.reactions),
    // Attached by the caller (`conversations.functions.ts`, `ActionCards.viewsFor`) in one
    // batched lookup per page; this function never queries `ActionCard` rows itself.
    actionCard: undefined as ActionCardView | undefined,
  };
}

/**
 * Messages an Agent has not yet consumed: from a user, or delivered explicitly to it — and in a
 * channel *only* when delivered, because a channel message the Agent was not addressed by is not
 * its attention to owe. The clause is not redundant with the `OR`: `(human ∨ delivered)` narrowed
 * by `delivered` is exactly `delivered`, so it is what keeps the channel case strict while the
 * direct case stays permissive (a DM's Agent-authored handoff carries a delivery row).
 */
function unreadForAgentWhere(agentId: string, isChannel: boolean) {
  return {
    OR: [{ sender: { userId: { not: null } } }, { deliveries: { some: { agentId } } }],
    ...(isChannel ? { deliveries: { some: { agentId } } } : {}),
  } satisfies Prisma.MessageWhereInput;
}

/**
 * Messages the Agent owes attention to: above its per-target read boundary, from a user, or
 * explicitly delivered to it; channels only count with a delivery row. Shared by
 * `readAgentRecoveryContext` and `drainAgentEvents` so the rule cannot drift between them.
 *
 * `senderUsername` is the message's own author (an Agent's name, else a human's username) and
 * `otherUsername` is the *recipient* — the conversation's other active member, which a DM target
 * needs and a message's sender cannot supply.
 */
function unreadAgentMessagesFragment(workspaceId: string, agentId: string) {
  return Prisma.sql`
    SELECT m."id", m."sequence", m."body", m."conversationId", m."threadRootId",
      m."senderMemberId", COALESCE(r."sequence", 0) AS "rootSequence",
      d."deliveryId", COALESCE(sa."name", su."username") AS "senderUsername", c."channelName",
      (SELECT COALESCE(ou."username", oa."name")
        FROM "conversation_members" om
        LEFT JOIN "users" ou ON ou."id" = om."userId"
        LEFT JOIN "agents" oa ON oa."id" = om."agentId"
        WHERE om."conversationId" = c."id" AND om."id" <> am."id" AND om."leftAt" IS NULL
        ORDER BY ou."username" NULLS LAST LIMIT 1) AS "otherUsername"
    FROM "messages" m
    JOIN "conversation_members" am ON am."conversationId" = m."conversationId"
      AND am."workspaceId" = ${workspaceId}::uuid AND am."agentId" = ${agentId}::uuid
      AND am."leftAt" IS NULL
    JOIN "conversations" c ON c."id" = m."conversationId"
    LEFT JOIN "messages" r ON r."id" = m."threadRootId"
    LEFT JOIN "thread_reads" tr ON tr."memberId" = am."id" AND tr."rootMessageId" = m."threadRootId"
    LEFT JOIN "conversation_members" sm ON sm."id" = m."senderMemberId"
    LEFT JOIN "users" su ON su."id" = sm."userId"
    LEFT JOIN "agents" sa ON sa."id" = sm."agentId"
    LEFT JOIN "agent_message_deliveries" d ON d."messageId" = m."id" AND d."agentId" = ${agentId}::uuid
    WHERE m."sequence" > CASE WHEN m."threadRootId" IS NULL
        THEN am."agentReadThroughSequence" ELSE COALESCE(tr."readThroughSequence", 0) END
      AND (sm."userId" IS NOT NULL OR d."deliveryId" IS NOT NULL)
      AND (c."channelName" IS NULL OR d."deliveryId" IS NOT NULL)`;
}

/**
 * Next sequence for a conversation; holds the conversation row lock until the transaction ends.
 * Exported so other message-anchored writers (e.g. `ActionCards.prepare`) serialize through the
 * same lock instead of reimplementing sequence allocation.
 */
export async function allocateSequence(tx: Prisma.TransactionClient, conversationId: string) {
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
  /** The conversation's other active member: the address a DM reply targets. */
  otherUsername: string | null;
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
    attachmentIds?: string[],
    threadRootId?: string,
  ): Promise<{
    id: string;
    body: string;
    createdAt: Date;
    sequence: number;
    /** The message's thread anchor, or null for a top-level message. */
    threadRootId: string | null;
    deliveryId?: string;
    workspaceId: string;
    agentId: string;
    computerId?: string;
    target?: string;
    latestSender?: string;
    deliveryTarget?: string;
    /** Always present, possibly empty; order matches send order. */
    attachments: AttachmentMetadata[];
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
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
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
    /** Always present, possibly empty; order matches send/upload order. */
    attachments: AttachmentMetadata[];
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
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
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
  /** Per-DM unread for the sidebar: other-authored top-level messages past the member's
   * cursor, keyed by the Agent whose row the badge belongs to (ADR 0046). One grouped query
   * for the whole Workspace; the agent member row is the join, never the viewer's own row. */
  unreadCountsForUser?(
    workspaceId: string,
    userId: string,
  ): Promise<
    Array<{
      agentId: string;
      unread: number;
    }>
  >;
  /** Advances the human member's DM read cursor; monotone and clamped like the channel one. */
  markReadForUser?(
    workspaceId: string,
    userId: string,
    agentId: string,
    throughSequence: number,
  ): Promise<void>;
  sendAgentMessage?(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string,
    mentions?: readonly AgentMentionBinding[],
  ): Promise<{
    id: string;
    body: string;
    createdAt: Date;
    sequence: number;
    /** The message's thread anchor, or null for a top-level message. */
    threadRootId: string | null;
    deliveryId?: string;
    workspaceId: string;
    agentId: string;
    target: string;
    /** `@name` of the sending Agent, for delivery envelopes. */
    latestSender?: string;
    /** Attention rows created for other Agents @mentioned in a channel message (never the sender). */
    deliveries?: { deliveryId: string; agentId: string; computerId: string | null }[];
    /** Resolved mention rows (empty for DMs); translates the body's embedded mention tokens. */
    mentions?: { kind: string; actorId: string; handle: string }[];
    /** Always present, possibly empty; order matches send order. */
    attachments: AttachmentMetadata[];
  }>;
  openForUser?(
    workspaceId: string,
    userId: string,
    agentId: string,
    page?: { beforeSequence?: number; limit?: number },
  ): Promise<{
    conversationId: string;
    senderMemberId: string;
    /** The viewer's conversation-level read cursor over top-level messages (ADR 0046). */
    readThroughSequence?: number;
    threadReadThrough?: Record<string, number>;
    agent: { id: string; name: string; displayName: string; deletedAt: Date | null };
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
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
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
          members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } },
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
        conversation: { members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } } },
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
      where: { conversationId: row.conversationId, workspaceId, agentId, ...ACTIVE_MEMBER_WHERE },
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
    // Deliberately *not* filtered by `ACTIVE_AGENT_WHERE`: a deleted Agent's direct conversation
    // stays readable (ADR 0044 keeps history), and `ownedConversations` decides per operation
    // whether reading or writing is allowed. Starting a new conversation with a deleted Agent is
    // unreachable anyway — the DM list and profile affordances no longer offer one.
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

  /** Read-only counterpart to `getOrCreateUserAgent`: looks the DM up, never creates it. Used by
   * `channel members @user`, which must not have the side effect of starting a DM just by
   * inspecting who could message in it. */
  async findUserAgentConversation(workspaceId: string, userId: string, agentId: string) {
    return this.db.conversation.findUnique({
      where: { workspaceId_directKey: { workspaceId, directKey: keyFor(userId, agentId) } },
      select: { id: true },
    });
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
            // The viewer's own conversation-level read cursor: the client positions the
            // initial view at the first unread message and draws the divider there (ADR 0046).
            readThroughSequence: true,
            threadReads: {
              select: { rootMessageId: true, readThroughSequence: true },
            },
            user: { select: { username: true } },
            agent: { select: { id: true, name: true, displayName: true, deletedAt: true } },
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
      // The viewer's conversation-level read boundary: first unread = first top-level
      // message past this. Thread replies are positioned by their thread instead.
      readThroughSequence: sender.readThroughSequence,
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

  async unreadCountsForUser(workspaceId: string, userId: string) {
    // One grouped scan over the user's own DM memberships: other-authored top-level messages
    // past the member's cursor. Direct conversations only (`directKey` is not null). The badge
    // key is the *agent* member of the conversation, not the viewer's own row: a DM's two
    // member rows are separate (one `userId`, one `agentId`), so `cm."agentId"` on the viewer's
    // row is always null. Driven from the viewer's memberships so the sequence range is an
    // index condition against `messages(conversationId, threadRootId, sequence)`.
    const rows = await this.db.$queryRaw<
      {
        agentId: string;
        unread: number;
      }[]
    >`
      SELECT am."agentId" AS "agentId", COUNT(m."id")::int AS "unread"
      FROM "conversation_members" cm
      JOIN "conversations" c
        ON c."id" = cm."conversationId" AND c."directKey" IS NOT NULL
      JOIN "conversation_members" am
        ON am."conversationId" = cm."conversationId"
       AND am."agentId" IS NOT NULL
       AND am."leftAt" IS NULL
      LEFT JOIN "messages" m
        ON m."conversationId" = cm."conversationId"
       AND m."threadRootId" IS NULL
       AND m."senderMemberId" IS NOT NULL
       AND m."senderMemberId" IS DISTINCT FROM cm."id"
       AND m."sequence" > cm."readThroughSequence"
      WHERE cm."userId" = ${userId}::uuid
        AND cm."leftAt" IS NULL
        AND cm."workspaceId" = ${workspaceId}::uuid
        AND c."workspaceId" = ${workspaceId}::uuid
      GROUP BY am."agentId"
    `;
    return rows;
  }

  async markReadForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    throughSequence: number,
  ) {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
      throw new AppError("INVALID_INPUT");
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    await this.db.$transaction(async (tx) => {
      const latest = await tx.message.findFirst({
        where: { conversationId: conversation.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const boundary = Math.min(throughSequence, latest?.sequence ?? 0);
      if (boundary < 1) return;
      await tx.conversationMember.updateMany({
        where: {
          conversationId: conversation.id,
          userId,
          readThroughSequence: { lt: boundary },
          leftAt: null,
        },
        data: { readThroughSequence: boundary },
      });
    });
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
    attachmentIds?: string[],
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
      // Validated before the message exists, then linked (messageId + position) once it does; see
      // the multi-attachment transaction pattern shared by every send path in this file.
      const attachments: {
        id: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        objectKey: string;
      }[] = [];
      for (const attachmentId of attachmentIds ?? []) {
        const attachment = await tx.attachment.findFirst({
          where: {
            id: attachmentId,
            conversationId,
            workspaceId: conversation.workspaceId,
            uploaderId: senderUserId,
            messageId: null,
          },
          select: { id: true, fileName: true, contentType: true, sizeBytes: true, objectKey: true },
        });
        if (!attachment) throw new Error("attachment is not available for this message");
        attachments.push(attachment);
      }
      const created = await tx.message.create({
        data: {
          conversationId,
          workspaceId: conversation.workspaceId,
          senderMemberId,
          threadRootId: root?.id,
          body,
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
          // Carried so the browser signal can exclude thread replies from channel unread.
          threadRootId: true,
          deliveries: { select: { deliveryId: true } },
        },
      });
      await Promise.all(
        attachments.map((attachment, position) =>
          tx.attachment.update({
            where: { id: attachment.id },
            data: { messageId: created.id, position },
          }),
        ),
      );
      return { ...created, attachments };
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
      attachments: message.attachments.map((attachment) => attachmentView(attachment)),
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
            sender: MESSAGE_SENDER_SELECT,
            mentions: MESSAGE_MENTIONS_SELECT,
          },
        },
      },
    });
    return deliveries.map((delivery) => {
      // An Agent-authored message has no `user` on its sender row, so a `user.username`-only
      // derivation produced a bare `@` and rejected every pending Agent message. Reuse the one
      // sender-handle rule the other Agent read paths use (see `agentSenderHandle`).
      const sender = agentSenderHandle(delivery.message.sender);
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
        body: agentReadableBody(delivery.message.body, delivery.message.mentions),
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
        "deliveryId", "senderUsername", "channelName", "otherUsername", "unreadCount", "globalRank"
      FROM ranked
      WHERE "globalRank" <= ${AGENT_RECOVERY_MESSAGE_LIMIT} OR "targetRank" = 1
      ORDER BY "globalRank"`;
    const resumeMessages: AgentRecoveryContext["resumeMessages"] = [];
    const unreadSummary: Record<string, number> = {};
    // The raw statement cannot join the mention rows, so translate embedded tokens in a second
    // pass; Agents only ever read plain `@handle` text.
    const mentionRows = rows.length
      ? await this.db.messageMention.findMany({
          where: { messageId: { in: rows.map((row) => row.id) } },
          select: { messageId: true, kind: true, actorId: true, handle: true },
        })
      : [];
    const mentionsByMessage = new Map<
      string,
      { kind: string; actorId: string; handle: string }[]
    >();
    for (const mention of mentionRows) {
      const list = mentionsByMessage.get(mention.messageId) ?? [];
      list.push(mention);
      mentionsByMessage.set(mention.messageId, list);
    }
    for (const row of rows) {
      if (!row.channelName && !row.otherUsername)
        throw new Error("Agent conversation has no other member to target");
      const target = deliveryTarget(
        row.channelName ? `#${row.channelName}` : `@${row.otherUsername}`,
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
        // The author, read from the message in every conversation kind. A DM's other member is
        // its *recipient*, so deriving the sender from the conversation attributes the message
        // to the wrong side — and, in a conversation with no user member, to nothing at all.
        // `?? "agent"` mirrors `agentSenderHandle`'s fallback so no NULL handle reaches the daemon.
        latestSender: row.senderMemberId === null ? "system" : `@${row.senderUsername ?? "agent"}`,
        body: agentReadableBody(row.body, mentionsByMessage.get(row.id) ?? []),
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
      include: {
        sender: MESSAGE_SENDER_SELECT,
        attachments: { orderBy: { position: "asc" } },
        mentions: MESSAGE_MENTIONS_SELECT,
      },
    });
    return rows.reverse().map((m) => ({
      id: m.id,
      sequence: m.sequence,
      sender: agentSenderHandle(m.sender),
      body: agentReadableBody(m.body, m.mentions),
      createdAt: m.createdAt,
      target: canonicalTarget,
      attachments: m.attachments,
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
    attachmentIds?: string[],
    threadRootId?: string,
    mentions?: readonly AgentMentionBinding[],
  ) {
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      include: {
        members: {
          include: {
            agent: { select: { name: true } },
            user: { select: { username: true } },
          },
        },
      },
    });
    if (!conversation) throw new Error("conversation scope is not authorized");
    if (conversation.channelName && conversation.archivedAt) throw new AppError("CONFLICT");
    const sender = conversation.members.find((m) => m.agentId === agentId && !m.leftAt);
    const user = conversation.members.find((m) => m.userId && !m.leftAt);
    if (!sender || (!conversation.channelName && !user))
      throw new Error("agent is not a conversation member");
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
    const result = await this.db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      // The sending Agent must be the same Agent that uploaded each attachment (ADR 0022's
      // "Known limitation" of never checking uploader identity, closed by ADR 0023's Agent
      // upload route: `uploaderAgentId` now names the uploading Agent). Validated before the
      // message exists, then linked (messageId + position) once it does.
      const attachments: {
        id: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
      }[] = [];
      for (const attachmentId of attachmentIds ?? []) {
        const attachment = await tx.attachment.findFirst({
          where: {
            id: attachmentId,
            conversationId,
            workspaceId: conversation.workspaceId,
            uploaderAgentId: agentId,
            messageId: null,
          },
          select: { id: true, fileName: true, contentType: true, sizeBytes: true },
        });
        if (!attachment)
          throw new AgentSendRejectedError(403, "attachment is not available for this message");
        attachments.push(attachment);
      }
      const mentionedMemberIds: string[] = [];
      if (mentions?.length) {
        for (const mention of mentions) {
          const match = conversation.members.find((member) =>
            mention.type === "user"
              ? member.userId === mention.id && member.user?.username === mention.name
              : member.agentId === mention.id && member.agent?.name === mention.name,
          );
          if (!match)
            throw new AgentSendRejectedError(
              400,
              `mention binding does not match a conversation member: @${mention.name}`,
            );
          mentionedMemberIds.push(match.id);
        }
      }
      // Channel bodies are persisted in the Slack-style token form: every @mention that
      // resolves to an active member — whether given as a structured `--mention` selector or
      // written plainly — becomes a `<@kind:uuid>` token plus a MessageMention row. DMs keep
      // plain text (no mention structure there).
      const resolution = conversation.channelName
        ? normalizeMentionBody(
            body,
            conversation.members
              .filter((member) => !member.leftAt)
              .map((member) =>
                member.userId
                  ? {
                      key: member.id,
                      type: "user" as const,
                      id: member.userId,
                      handle: member.user!.username,
                    }
                  : {
                      key: member.id,
                      type: "agent" as const,
                      id: member.agentId!,
                      handle: member.agent!.name,
                    },
              ),
            mentions ?? [],
          )
        : { body, mentions: [] };
      // Other Agents this channel message wakes: every resolved Agent mention. An Agent message
      // without an Agent mention never notifies another Agent, and an Agent never wakes itself.
      const mentionedAgentIds = new Set(
        resolution.mentions
          .filter((mention) => mention.type === "agent")
          .map((mention) => mention.id),
      );
      mentionedAgentIds.delete(agentId);
      if (conversation.channelName && root) {
        const names = mentionedNames(body);
        const mentioned = await tx.conversationMember.findMany({
          where: {
            conversationId,
            OR: [{ user: { username: { in: names } } }, { agent: { name: { in: names } } }],
            ...ACTIVE_MEMBER_WHERE,
          },
          select: { id: true },
        });
        const followerIds = new Set([
          sender.id,
          ...mentioned.map(({ id }) => id),
          ...mentionedMemberIds,
        ]);
        await tx.threadFollow.createMany({
          data: [...followerIds].map((memberId) => ({
            memberId,
            rootMessageId: root.id,
            conversationId,
            workspaceId: conversation.workspaceId,
          })),
          skipDuplicates: true,
        });
      }
      const created = await tx.message.create({
        data: {
          conversationId,
          workspaceId: conversation.workspaceId,
          senderMemberId: sender.id,
          threadRootId: root?.id,
          body: resolution.body,
          sequence,
          mentions: resolution.mentions.length
            ? {
                create: resolution.mentions.map((mention) => ({
                  memberId: mention.key,
                  workspaceId: conversation.workspaceId,
                  kind: mention.type,
                  actorId: mention.id,
                  handle: mention.handle,
                })),
              }
            : undefined,
          deliveries: mentionedAgentIds.size
            ? {
                create: [...mentionedAgentIds].map((wakeAgentId) => ({
                  workspaceId: conversation.workspaceId,
                  conversationId,
                  agentId: wakeAgentId,
                  sequence,
                })),
              }
            : undefined,
        },
        select: {
          id: true,
          body: true,
          createdAt: true,
          sequence: true,
          // Carried so the browser signal can exclude thread replies from channel unread.
          threadRootId: true,
          mentions: { select: { kind: true, actorId: true, handle: true } },
          deliveries: {
            select: {
              deliveryId: true,
              agentId: true,
              agent: { select: { computerId: true } },
            },
          },
        },
      });
      await Promise.all(
        attachments.map((attachment, position) =>
          tx.attachment.update({
            where: { id: attachment.id },
            data: { messageId: created.id, position },
          }),
        ),
      );
      return { ...created, attachments };
    });
    return {
      ...result,
      // Agent-originated messages must never be enqueued back to the sender.
      deliveryId: undefined,
      workspaceId: conversation.workspaceId,
      agentId,
      latestSender: `@${sender.agent?.name ?? agentId}`,
      deliveries: result.deliveries.map((delivery) => ({
        deliveryId: delivery.deliveryId,
        agentId: delivery.agentId,
        computerId: delivery.agent.computerId,
      })),
      target: conversation.channelName
        ? deliveryTarget(`#${conversation.channelName}`, root?.id)
        : "",
      // Agent-facing shape: metadata only; the object key never leaves the backend (never
      // selected above, unlike the browser-facing ATTACHMENT_SELECT).
      attachments: result.attachments,
    };
  }
}
