import { lockConversation } from "../../conversations/conversation-lock.server";
import type { MessageSenderKind, MessageTaskMetadata, TaskStatus } from "@lrm/coforge-sdk/internal";
import {
  normalizeMentionBody,
  resolveTaskReferences,
  taskReferenceNumbers,
} from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "../../../../generated/client";
import { AppError } from "../../../lib/app-error";
import { canDirectMessageAgent } from "../../agents/agent-visibility.server";
import { AgentMessageValidationError } from "../../conversations/agent-message-validation-error.server";
import { messageAnchorWhere } from "../message-anchor";
import { getAgentChannel, PublicChannels } from "../../conversations/public-channels.server";
import { ACTIVE_MEMBER_WHERE } from "../../conversations/active-member.server";
import {
  agentReadableBody,
  BROWSER_MESSAGE_MENTIONS_SELECT,
  browserMessageMention,
  deliveryMentionsAgent,
  mentionedNames,
} from "../../conversations/mentions";
import { AgentSendRejectedError } from "../../conversations/agent-send-rejected-error.server";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
} from "../../conversations/message-reactions.server";
import { toggleUserMessageReaction } from "../../conversations/user-message-reactions.server";
import {
  agentMessageSender,
  browserSenderHandle,
  browserSenderName,
  MESSAGE_SENDER_SELECT,
} from "../../conversations/sender-display.server";
import { agentAvatarUrl } from "../../agents/agent-avatar.server";
import { workspaceUserAvatarUrl } from "./user-profile.repositories.server";
import { attachmentView } from "../../attachments/attachment-view.server";
import type { ActionCardView } from "../../conversations/action-cards.server";
import { windowPageFlags } from "../../../lib/conversation-window";

/** The three Agent-visible sender facts, spread onto every Agent-facing message shape
 * in this file so they cannot drift into three different field sets. */
type AgentFacingSender = {
  senderKind: MessageSenderKind;
  senderHandle: string;
  senderDescription: string;
};

/** The `latestSender`-prefixed sibling of `AgentFacingSender`: the same three facts, attached to
 * a target's attention summary or delivery envelope rather than a specific message's own sender.
 * Exported so `message-request-idempotency.server.ts` and `direct-message.server.ts` share this
 * one field set instead of restating it. */
export type LatestSenderFields = {
  latestSenderKind: MessageSenderKind;
  latestSenderHandle: string;
  latestSenderDescription: string;
};

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
  messages: ({
    id: string;
    sequence: number;
    body: string;
    createdAt: Date;
    target: string;
    /** Always present, possibly empty; order matches send/upload order. */
    attachments: AttachmentMetadata[];
    task?: MessageTaskMetadata;
  } & AgentFacingSender)[];
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
  resumeMessages: Array<
    {
      messageId: string;
      deliveryId: string;
      conversationId: string;
      sequence: number;
      target: string;
      body: string;
    } & LatestSenderFields
  >;
  unreadSummary: Readonly<Record<string, number>>;
};

export type PendingAgentDelivery = AgentRecoveryContext["resumeMessages"][number] & {
  mentionsAgent?: boolean;
};

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
      agent: { select: { name: true, displayName: true, deletedAt: true, avatarObjectKey: true } },
    },
  },
  mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
  reactions: MESSAGE_REACTIONS_SELECT,
} satisfies Prisma.MessageSelect;

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

function toAgentMessage(
  row: Pick<DirectConversationMessageRow, "id" | "sequence" | "body" | "createdAt"> & {
    sender: Parameters<typeof agentMessageSender>[0];
    task: Parameters<typeof messageTask>[0];
    attachments: AttachmentMetadata[];
    actionCard?: { state: string } | null;
    mentions?: { kind: string; actorId: string; handle: string }[];
  },
  target: string,
  readerAgentId?: string,
) {
  const task = messageTask(row.task);
  const sender = agentMessageSender(row.sender);
  // Agents read plain `@handle` text: the embedded-UUID token form is a storage/browser concern
  // and never crosses onto the Agent channel.
  const body = agentReadableBody(row.body, row.mentions ?? []);
  const mentionsAgent = readerAgentId ? deliveryMentionsAgent(row.mentions, readerAgentId) : false;
  return {
    id: row.id,
    sequence: row.sequence,
    senderKind: sender.kind,
    senderHandle: sender.handle,
    senderDescription: sender.description,
    // An Agent reads message text, not the browser card UI; append the card's current state so it
    // never claims a resource exists before a human has actually committed the card.
    body: row.actionCard ? `${body} [action card: ${row.actionCard.state}]` : body,
    createdAt: row.createdAt,
    target,
    attachments: row.attachments,
    ...(task ? { task } : {}),
    ...(mentionsAgent ? { mentionsAgent: true } : {}),
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
    /** True when the sending Agent has since been deleted: the row renders its sender
     * greyed with a `DELETED` marker, and no longer opens that Agent's profile. */
    senderDeleted: Boolean(message.sender?.agent?.deletedAt),
    senderAvatarUrl: message.sender?.userId
      ? workspaceUserAvatarUrl(
          workspaceId,
          message.sender.userId,
          message.sender.user?.avatarObjectKey ?? null,
        )
      : message.sender?.agentId
        ? agentAvatarUrl(
            workspaceId,
            message.sender.agentId,
            message.sender.agent?.avatarObjectKey ?? null,
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
 * `senderAgentName`/`senderAgentDescription` and `senderUsername`/`senderUserDescription` carry
 * the message's own author (an Agent, else a human) as separate columns rather than one merged
 * name, so the caller can tell which kind it is and attach its description; a raw SQL
 * statement cannot call the shared `agentMessageSender` projection directly. `otherUsername` is
 * the *recipient* — the conversation's other active member, which a DM target needs and a
 * message's sender cannot supply.
 */
function unreadAgentMessagesFragment(workspaceId: string, agentId: string) {
  return Prisma.sql`
    SELECT m."id", m."sequence", m."body", m."conversationId", m."threadRootId",
      m."senderMemberId", COALESCE(r."sequence", 0) AS "rootSequence",
      d."deliveryId", sa."name" AS "senderAgentName", sa."description" AS "senderAgentDescription",
      su."username" AS "senderUsername", su."description" AS "senderUserDescription",
      c."channelName",
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
  senderAgentName: string | null;
  senderAgentDescription: string | null;
  senderUsername: string | null;
  senderUserDescription: string | null;
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
  ): Promise<
    {
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
      deliveryTarget?: string;
      /** Always present, possibly empty; order matches send order. */
      attachments: AttachmentMetadata[];
    } & Partial<LatestSenderFields>
  >;
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
    ({
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender)[]
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
  ): Promise<
    {
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender
  >;
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
    messages: ({
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      /** Always present, possibly empty; order matches send/upload order. */
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender)[];
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
   * cursor, keyed by the Agent whose row the badge belongs to. One grouped query
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
  ): Promise<
    {
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
      /** Attention rows created for other Agents @mentioned in a channel message (never the sender). */
      deliveries?: { deliveryId: string; agentId: string; computerId: string | null }[];
      /** Resolved mention rows (empty for DMs); translates the body's embedded mention tokens. */
      mentions?: { kind: string; actorId: string; handle: string }[];
      /** Always present, possibly empty; order matches send order. */
      attachments: AttachmentMetadata[];
      // The sending Agent's identity, for delivery envelopes.
    } & Partial<LatestSenderFields>
  >;
  openForUser?(
    workspaceId: string,
    userId: string,
    agentId: string,
    page?: { beforeSequence?: number; afterSequence?: number; limit?: number },
  ): Promise<{
    conversationId: string;
    senderMemberId: string;
    /** The viewer's conversation-level read cursor over top-level messages. */
    readThroughSequence?: number;
    threadReadThrough?: Record<string, number>;
    agent: { id: string; name: string; displayName: string; deletedAt: Date | null };
    /** Whether this viewer may still send here; see `PrismaDirectConversationRepository`. */
    dmWritable: boolean;
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
        id: messageAnchorWhere(anchor),
      },
      take: 2,
      select: { id: true, sequence: true, threadRootId: true, senderMemberId: true },
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
        id: messageAnchorWhere(anchor),
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

  /**
   * The browser's own emoji reaction in this user's DM with one Agent. Read-only
   * conversation lookup: reacting must never start a DM as a side effect. Scope
   * authorization stays with the caller (`ownedConversations` in the function layer).
   */
  async setUserMessageReaction(
    workspaceId: string,
    userId: string,
    agentId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ) {
    const conversation = await this.findUserAgentConversation(workspaceId, userId, agentId);
    if (!conversation) throw new AppError("NOT_FOUND");
    return toggleUserMessageReaction(this.db, {
      workspaceId,
      conversationId: conversation.id,
      userId,
      messageId,
      emoji,
      active,
    });
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
    // stays readable (history is kept), and `ownedConversations` decides per operation
    // whether reading or writing is allowed. Starting a new conversation with a deleted Agent is
    // unreachable anyway — the DM list and profile affordances no longer offer one.
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, workspace: { members: { some: { userId } } } },
      select: { id: true, ownerId: true, visibility: true },
    });
    if (!agent) throw new Error("conversation scope is not authorized");
    const where = { workspaceId_directKey: { workspaceId, directKey: keyFor(userId, agentId) } };
    const existing = await this.db.conversation.findUnique({ where, select: { id: true } });
    if (existing) return existing;
    // A brand-new DM with a private Agent may only ever be started by its own creator:
    // an existing DM someone else already had stays readable/read-only (handled above by
    // returning it unconditionally), but nobody else may open a first one.
    if (!canDirectMessageAgent(userId, agent)) throw new AppError("AGENT_DM_RESTRICTED");
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

  /**
   * The viewer's own membership of their DM with this Agent, resolved without creating anything:
   * a preference must not bring a conversation into existence as a side effect. `NOT_FOUND` covers
   * both "no DM yet" and "not this viewer's DM", so the mutations cannot probe another pair.
   */
  private async memberForPreference(workspaceId: string, userId: string, agentId: string) {
    const conversation = await this.findUserAgentConversation(workspaceId, userId, agentId);
    if (!conversation) throw new AppError("NOT_FOUND");
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId: conversation.id, userId, leftAt: null },
      select: { id: true },
    });
    if (!member) throw new AppError("NOT_FOUND");
    return { conversationId: conversation.id, memberId: member.id };
  }

  /** Pins the viewer's DM with this Agent above the rest of their list, or unpins it (#121). The
   * conversation lock orders it against concurrent writes the way the channel side does. */
  async setPinnedForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    pinned: boolean,
    sortOrder?: number,
  ) {
    const { conversationId, memberId } = await this.memberForPreference(
      workspaceId,
      userId,
      agentId,
    );
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      const where = { conversationId, memberId };
      if (!pinned) {
        await tx.conversationPin.deleteMany({ where });
        return;
      }
      const order = sortOrder ?? (await tx.conversationPin.count({ where: { memberId } }));
      await tx.conversationPin.upsert({
        where: { conversationId_memberId: where },
        create: { conversationId, memberId, workspaceId, sortOrder: order },
        update: { sortOrder: order },
      });
    });
    return { pinned };
  }

  /** Marks the viewer's DM with this Agent unread, anchored on its newest top-level message, or
   * clears the marker. A DM with no messages has nothing to mark. */
  async setUnreadForUser(workspaceId: string, userId: string, agentId: string, unread: boolean) {
    const { conversationId } = await this.memberForPreference(workspaceId, userId, agentId);
    let marker: number | null = null;
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      if (unread) {
        const newest = await tx.message.findFirst({
          where: { conversationId, threadRootId: null },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        marker = newest?.sequence ?? null;
      }
      await tx.conversationMember.updateMany({
        where: { conversationId, userId, leftAt: null },
        data: { unreadFromSequence: marker },
      });
    });
    return { unread: marker !== null };
  }

  /** Closes the viewer's DM with this Agent in their list only, or brings it back. */
  async setHiddenForUser(workspaceId: string, userId: string, agentId: string, hidden: boolean) {
    const { conversationId } = await this.memberForPreference(workspaceId, userId, agentId);
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      await tx.conversationMember.updateMany({
        where: { conversationId, userId, leftAt: null },
        data: { hiddenAt: hidden ? new Date() : null },
      });
    });
    return { hidden };
  }

  /**
   * What the sidebar needs about the viewer's own DMs, keyed the way it addresses them: an Agent id
   * (DM rows come from the live Agent list, not from a server list). Pins carry their order; hidden
   * DMs are listed so the sidebar can leave them out.
   */
  async preferencesForUser(workspaceId: string, userId: string) {
    const dmScope = {
      workspaceId,
      userId,
      leftAt: null,
      conversation: { directKey: { not: null } },
    };
    const [conversations, pins, hidden] = await Promise.all([
      // Which of the live Agent rows are conversations at all: DM rows come from the Agent list, so
      // this is the only way the sidebar can tell a started DM from an Agent it has never written
      // to — and a preference must not be offered on the latter (it would only answer NOT_FOUND).
      this.db.conversationMember.findMany({
        where: dmScope,
        select: {
          conversation: {
            select: { members: { where: { agentId: { not: null } }, select: { agentId: true } } },
          },
        },
      }),
      this.db.conversationPin.findMany({
        where: {
          workspaceId,
          member: { userId, leftAt: null },
          conversation: { directKey: { not: null } },
        },
        select: {
          sortOrder: true,
          conversation: {
            select: { members: { where: { agentId: { not: null } }, select: { agentId: true } } },
          },
        },
      }),
      this.db.conversationMember.findMany({
        where: { ...dmScope, hiddenAt: { not: null } },
        select: {
          hiddenAt: true,
          conversation: {
            select: {
              members: { where: { agentId: { not: null } }, select: { agentId: true } },
              // The Agent's newest top-level message: one posted after the close brings the DM
              // back to the list (opening it reopens it for good).
              messages: {
                where: { threadRootId: null, sender: { agentId: { not: null } } },
                orderBy: { sequence: "desc" },
                take: 1,
                select: { createdAt: true },
              },
            },
          },
        },
      }),
    ]);
    return {
      conversations: conversations.flatMap((row) =>
        row.conversation.members.map((member) => member.agentId!),
      ),
      pinned: pins
        .flatMap((pin) =>
          pin.conversation.members.map((m) => ({ agentId: m.agentId!, sortOrder: pin.sortOrder })),
        )
        .sort((left, right) => left.sortOrder - right.sortOrder),
      hidden: hidden
        .filter((row) => {
          const latest = row.conversation.messages.at(0);
          return !(latest && row.hiddenAt && latest.createdAt > row.hiddenAt);
        })
        .flatMap((row) => row.conversation.members.map((m) => m.agentId!)),
    };
  }

  async openForUser(
    workspaceId: string,
    userId: string,
    agentId: string,
    page: { beforeSequence?: number; afterSequence?: number; limit?: number } = {},
  ) {
    const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
    const limit = Math.min(page.limit ?? 50, 100);
    // A forward fetch reads towards the live end, from the newest sequence the retained window
    // still holds; a backward fetch reads history upwards from its oldest. Neither is the initial
    // (uncursored) load, which lands on the newest page (see `lib/conversation-window.ts`).
    const forward = page.afterSequence !== undefined;
    const row = await this.db.conversation.findUnique({
      where: { id: conversation.id },
      select: {
        members: {
          select: {
            id: true,
            userId: true,
            agentId: true,
            // The viewer's own conversation-level read cursor: the client positions the
            // initial view at the first unread message and draws the divider there.
            readThroughSequence: true,
            hiddenAt: true,
            threadReads: {
              select: { rootMessageId: true, readThroughSequence: true },
            },
            // The full public profile: the pane resolves stored `<@kind:uuid>` tokens (and offers
            // @-completion) from these rows, so a mention of the viewer — the row that used to be
            // missing — is resolvable without a second query.
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
                deletedAt: true,
                avatarObjectKey: true,
                // Not sent to the browser (see the trimmed `agent:` field below); read only to
                // compute `dmWritable`.
                ownerId: true,
                visibility: true,
              },
            },
          },
        },
        messages: {
          where: {
            threadRootId: null,
            sequence: forward
              ? { gt: page.afterSequence }
              : page.beforeSequence
                ? { lt: page.beforeSequence }
                : undefined,
          },
          // Both directions take `limit + 1` rows to learn whether one more remains; the page
          // itself is re-sorted by sequence below, so only the overflow row's presence matters.
          orderBy: { sequence: forward ? ("asc" as const) : ("desc" as const) },
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
    const overflow = row.messages.length > limit;
    const { hasOlder, hasNewer } = windowPageFlags(
      forward ? "forward" : page.beforeSequence ? "backward" : "initial",
      overflow,
    );
    // The overflow row is always the newest of the fetched rows, so dropping the tail of the
    // ordered list keeps the reader's side of the window and drops the row that only proved there
    // was more.
    const pageRows = row.messages.slice(0, limit);
    const messages = (forward ? pageRows : pageRows.reverse())
      .flatMap((message) => [message, ...message.replies])
      .sort((left, right) => left.sequence - right.sequence);
    return {
      conversationId: conversation.id,
      senderMemberId: sender.id,
      // The viewer's conversation-level read boundary: first unread = first top-level
      // message past this. Thread replies are positioned by their thread instead.
      readThroughSequence: sender.readThroughSequence,
      // The viewer closed this DM: opening it is what brings it back to their list.
      hidden: sender.hiddenAt != null,
      threadReadThrough: Object.fromEntries(
        sender.threadReads.map((r) => [r.rootMessageId, r.readThroughSequence]),
      ),
      // Never `agentMember.agent` wholesale: `ownerId`/`visibility` are read above only to
      // compute `dmWritable` and must not reach the browser payload.
      agent: {
        id: agentMember.agent.id,
        name: agentMember.agent.name,
        displayName: agentMember.agent.displayName,
        deletedAt: agentMember.agent.deletedAt,
        avatarUrl: agentAvatarUrl(
          workspaceId,
          agentMember.agent.id,
          agentMember.agent.avatarObjectKey,
        ),
      },
      // Whether this viewer may still send here: a private Agent's DM stays scoped to
      // its own creator, so an existing DM held by anyone else reads read-only once it goes
      // private. Independent of `deletedAt`'s own read-only rule.
      dmWritable: canDirectMessageAgent(userId, agentMember.agent),
      viewerHandle: sender.user?.username,
      // Who a mention here can be resolved to. A direct conversation has no candidate affinity to
      // rank (see `mentionAffinityScores`), so every member scores 0 and handle order is the whole
      // ordering; the viewer's own row is included because this list is also what *resolves* a
      // mention of them — leaving it out rendered `<@human:uuid>` raw in their own pane.
      mentionables: row.members
        .map((member) =>
          member.user
            ? {
                kind: "user" as const,
                id: member.user.id,
                handle: member.user.username,
                label: member.user.displayName?.trim() || member.user.username,
                description: member.user.description?.trim() ?? "",
                avatarUrl: workspaceUserAvatarUrl(
                  workspaceId,
                  member.user.id,
                  member.user.avatarObjectKey ?? null,
                ),
                mentionScore: 0,
              }
            : member.agent
              ? {
                  kind: "agent" as const,
                  id: member.agent.id,
                  handle: member.agent.name,
                  label: member.agent.displayName?.trim() || member.agent.name,
                  description: member.agent.description?.trim() ?? "",
                  avatarUrl: agentAvatarUrl(
                    workspaceId,
                    member.agent.id,
                    member.agent.avatarObjectKey,
                  ),
                  mentionScore: 0,
                }
              : undefined,
        )
        .filter((mentionable) => mentionable !== undefined)
        .sort((left, right) => left.handle.localeCompare(right.handle)),
      hasOlder,
      hasNewer,
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
       AND (
         m."sequence" > cm."readThroughSequence"
         OR cm."unreadFromSequence" IS NOT NULL AND m."sequence" >= cm."unreadFromSequence"
       )
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
      // Reading past the forced `mark as unread` marker consumes it, so the badge does not come
      // back on the next render (same rule as the channel side).
      await tx.conversationMember.updateMany({
        where: {
          conversationId: conversation.id,
          userId,
          unreadFromSequence: { not: null, lte: boundary },
          leftAt: null,
        },
        data: { unreadFromSequence: null },
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
            user: { select: { username: true, description: true } },
            agent: { select: { name: true, computerId: true, ownerId: true, visibility: true } },
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
    // A private Agent's direct conversation stays scoped to its own creator: once it
    // goes private, an existing DM held by anyone else stops accepting new messages, though its
    // history stays readable.
    if (agents[0].agent && !canDirectMessageAgent(senderUserId, agents[0].agent))
      throw new AppError("AGENT_DM_RESTRICTED");
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
    const message = await this.db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      // Validated before the message exists, then linked (messageId + position) once it does; see
      // the multi-attachment transaction pattern shared by every send path in this file.
      const requestedAttachmentIds = attachmentIds ?? [];
      const availableAttachments = requestedAttachmentIds.length
        ? await tx.attachment.findMany({
            where: {
              id: { in: [...new Set(requestedAttachmentIds)] },
              conversationId,
              workspaceId: conversation.workspaceId,
              uploaderId: senderUserId,
              messageId: null,
            },
            select: {
              id: true,
              fileName: true,
              contentType: true,
              sizeBytes: true,
              objectKey: true,
            },
          })
        : [];
      const attachmentsById = new Map(
        availableAttachments.map((attachment) => [attachment.id, attachment]),
      );
      const attachments: {
        id: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        objectKey: string;
      }[] = [];
      for (const attachmentId of requestedAttachmentIds) {
        const attachment = attachmentsById.get(attachmentId);
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
    const senderIdentity = agentMessageSender({ agentId: null, agent: null, user: sender.user });
    return {
      ...message,
      deliveryId: message.deliveries[0]!.deliveryId,
      workspaceId: conversation.workspaceId,
      agentId: agents[0].agentId,
      computerId: agents[0].agent?.computerId ?? undefined,
      target: `@${agents[0].agent?.name ?? "unknown"}`,
      latestSenderKind: senderIdentity.kind,
      latestSenderHandle: senderIdentity.handle,
      latestSenderDescription: senderIdentity.description,
      deliveryTarget: deliveryTarget(`@${senderIdentity.handle}`, root?.id),
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
      // sender projection every Agent read path calls (`agentMessageSender`): it
      // throws a named error rather than shipping a degraded identity, and the handle it
      // returns is already checked against the public handle grammar.
      const sender = agentMessageSender(delivery.message.sender);
      const target = deliveryTarget(
        conversationTarget(delivery.conversation),
        delivery.message.threadRootId,
      );
      return {
        messageId: delivery.messageId,
        deliveryId: delivery.deliveryId,
        conversationId: delivery.conversationId,
        sequence: delivery.sequence,
        target,
        latestSenderKind: sender.kind,
        latestSenderHandle: sender.handle,
        latestSenderDescription: sender.description,
        body: agentReadableBody(delivery.message.body, delivery.message.mentions),
        ...(deliveryMentionsAgent(delivery.message.mentions, agentId)
          ? { mentionsAgent: true }
          : {}),
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
        "deliveryId", "senderAgentName", "senderAgentDescription", "senderUsername",
        "senderUserDescription", "channelName", "otherUsername", "unreadCount", "globalRank"
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
      // The author, read from the message in every conversation kind. A DM's other member is its
      // *recipient*, so deriving the sender from the conversation attributes the message to the
      // wrong side — and, in a conversation with no user member, to nothing at all. Routed through
      // the shared projection so a missing name fails loudly rather than degrading.
      const sender = agentMessageSender(
        row.senderMemberId === null
          ? null
          : {
              agentId: row.senderAgentName !== null ? row.senderMemberId : null,
              agent:
                row.senderAgentName !== null
                  ? { name: row.senderAgentName, description: row.senderAgentDescription ?? "" }
                  : null,
              user:
                row.senderUsername !== null
                  ? { username: row.senderUsername, description: row.senderUserDescription ?? "" }
                  : null,
            },
      );
      resumeMessages.push({
        messageId: row.id,
        deliveryId: row.deliveryId,
        conversationId: row.conversationId,
        sequence: row.sequence,
        target,
        latestSenderKind: sender.kind,
        latestSenderHandle: sender.handle,
        latestSenderDescription: sender.description,
        body: agentReadableBody(row.body, mentionsByMessage.get(row.id) ?? []),
      });
    }
    return { resumeMessages, unreadSummary };
  }

  /**
   * Drains up to `limit` messages the Agent still owes attention to, in global
   * `(conversation, thread root, sequence)` order, and advances its read boundary for exactly the
   * targets returned (ack-on-drain). Boundaries only move forward. Default page is 20 (capped at
   * 100) so an unscoped check does not dump a 50-row wall of full bodies into the transcript.
   */
  async drainAgentEvents(
    workspaceId: string,
    agentId: string,
    limit = 20,
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
          agentId,
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
    return rows.reverse().map((m) => this.#agentContextRecord(m, canonicalTarget));
  }

  /**
   * The target's most recent messages, ignoring the Agent's own read boundary or own messages: the
   * source of Raft's first-touch `syncing_hold` (`target_first_touch_recent_context`). Own messages
   * are not context to review, so they are excluded.
   */
  async readRecentAgentContext(
    workspaceId: string,
    agentId: string,
    target: string,
    limit: number,
  ) {
    const { conversationId, threadRootId, canonicalTarget, isChannel } =
      await this.resolveAgentTarget(workspaceId, agentId, target);
    const agentMember = await this.db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true },
    });
    const rows = await this.db.message.findMany({
      where: {
        conversationId,
        threadRootId,
        ...(agentMember ? { senderMemberId: { not: agentMember.id } } : {}),
        ...unreadForAgentWhere(agentId, isChannel),
      },
      orderBy: { sequence: "desc" },
      take: limit,
      include: {
        sender: MESSAGE_SENDER_SELECT,
        attachments: { orderBy: { position: "asc" } },
        mentions: MESSAGE_MENTIONS_SELECT,
      },
    });
    return rows.reverse().map((m) => this.#agentContextRecord(m, canonicalTarget));
  }

  /** One row of the Agent-facing context window, shared by the pending and recent readers so both
   * surfaces cannot drift apart. */
  #agentContextRecord<
    Row extends {
      id: string;
      sequence: number;
      sender: Parameters<typeof agentMessageSender>[0];
      body: string;
      mentions: Parameters<typeof agentReadableBody>[1];
      createdAt: Date;
      attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[];
    },
  >(m: Row, canonicalTarget: string) {
    const sender = agentMessageSender(m.sender);
    return {
      id: m.id,
      sequence: m.sequence,
      senderKind: sender.kind,
      senderHandle: sender.handle,
      senderDescription: sender.description,
      body: agentReadableBody(m.body, m.mentions),
      createdAt: m.createdAt,
      target: canonicalTarget,
      attachments: m.attachments,
    };
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
            agent: MESSAGE_SENDER_SELECT.select.agent,
            user: MESSAGE_SENDER_SELECT.select.user,
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
    // A private Agent's own outbound DM is just as read-only as the human side of it
    // ("neither side can send"). Channels are unaffected — a private Agent is never a channel
    // member in the first place, so this only ever narrows the direct-conversation case.
    if (!conversation.channelName && user) {
      const self = await this.db.agent.findUnique({
        where: { id: agentId },
        select: { ownerId: true, visibility: true },
      });
      if (self && !canDirectMessageAgent(user.userId!, self))
        throw new AgentSendRejectedError(
          403,
          "this Agent is private; the direct message is read-only",
        );
    }
    const root = threadRootId
      ? await this.resolveMessage(conversationId, threadRootId, true)
      : undefined;
    const result = await this.db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      // The sending Agent must be the same Agent that uploaded each attachment (the
      // earlier limitation of never checking uploader identity, closed by the Agent
      // upload route: `uploaderAgentId` now names the uploading Agent). Validated before the
      // message exists, then linked (messageId + position) once it does.
      const requestedAttachmentIds = attachmentIds ?? [];
      const availableAttachments = requestedAttachmentIds.length
        ? await tx.attachment.findMany({
            where: {
              id: { in: [...new Set(requestedAttachmentIds)] },
              conversationId,
              workspaceId: conversation.workspaceId,
              uploaderAgentId: agentId,
              messageId: null,
            },
            select: { id: true, fileName: true, contentType: true, sizeBytes: true },
          })
        : [];
      const attachmentsById = new Map(
        availableAttachments.map((attachment) => [attachment.id, attachment]),
      );
      const attachments: {
        id: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
      }[] = [];
      for (const attachmentId of requestedAttachmentIds) {
        const attachment = attachmentsById.get(attachmentId);
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
      // The same structured-reference treatment as mentions, but for tasks and on every
      // conversation: a `task #N` that names a real task here becomes a stored `<@task:N>` token,
      // so a renderer reads the reference back as a chip instead of parsing prose.
      const referencedTaskNumbers = taskReferenceNumbers(resolution.body);
      const knownTaskNumbers = referencedTaskNumbers.length
        ? new Set(
            (
              await tx.task.findMany({
                where: { conversationId, number: { in: referencedTaskNumbers } },
                select: { number: true },
              })
            ).map((task) => task.number),
          )
        : new Set<number>();
      const taskResolution = resolveTaskReferences(resolution.body, (number) =>
        knownTaskNumbers.has(number),
      );
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
        // Enroll the root author only for the first reply. An explicit unfollow is a durable
        // choice and later replies must not silently add that member back.
        const existingFollower = await tx.threadFollow.findFirst({
          where: { rootMessageId: root.id },
          select: { memberId: true },
        });
        if (root.senderMemberId && !existingFollower) followerIds.add(root.senderMemberId);
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
          body: taskResolution.body,
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
    // Never falls back to the internal Agent id: a missing name fails loudly.
    const senderIdentity = agentMessageSender({ agentId, agent: sender.agent, user: null });
    return {
      ...result,
      // Agent-originated messages must never be enqueued back to the sender.
      deliveryId: undefined,
      workspaceId: conversation.workspaceId,
      agentId,
      latestSenderKind: senderIdentity.kind,
      latestSenderHandle: senderIdentity.handle,
      latestSenderDescription: senderIdentity.description,
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
