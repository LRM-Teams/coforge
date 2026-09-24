import type { PrismaClient } from "#src/generated/prisma/client";
import {
  agentReadableBody,
  MESSAGE_MENTIONS_SELECT,
} from "#src/server/conversations/mentions.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { messageNotificationTag } from "./web-push-notifications.server";
import type {
  MessageWebPushNotification,
  RecipientNotification,
  WebPushSubscriptionInput,
  WebPushSubscriptionStore,
} from "./web-push-notifications.server";

const MESSAGE_PREVIEW_LENGTH = 180;

type MessageContext = {
  message: {
    id: string;
    conversationId: string;
    workspaceId: string;
    senderMemberId: string | null;
    threadRootId: string | null;
  };
  channelName: string | null;
  /** The users the message's stored mention rows name; a mention pierces channel mute. */
  mentionedUserIds: string[];
  title: string;
  body: string;
  url: string;
  /** The un-anchored target: what `notificationForRecipient` hands the browser to compare against
   * the conversation it may already be looking at. */
  conversationPath: string;
};

export class PrismaWebPushSubscriptionStore implements WebPushSubscriptionStore {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Everything about a message that does not depend on which recipient is asking: its title/body/
   * url/conversationPath, and the ingredients (`channelName`, `mentionedUserIds`) the shared
   * recipient-eligibility where-clause needs. `notificationForMessage` and `notificationForRecipient`
   * both build on this single read so the recipient rule itself lives in exactly one place
   * (`recipientWhere`).
   */
  private async loadMessageContext(messageId: string): Promise<MessageContext | null> {
    const message = await this.db.message.findUnique({
      where: { id: messageId },
      include: {
        sender: {
          select: { agent: { select: { name: true } }, user: { select: { username: true } } },
        },
        mentions: MESSAGE_MENTIONS_SELECT,
        conversation: {
          include: {
            workspace: { select: { slug: true } },
            members: {
              where: { agentId: { not: null } },
              select: { agentId: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!message) return null;
    const channelName = message.conversation.channelName;
    // Stored bodies carry mentions as embedded-UUID tokens; the preview reads them back as
    // `@handle` text. Mention-pierce reads the stored mention rows themselves, the same rows the
    // renderer chips, so an `@handle` in code or a link label pierces nothing.
    const readableBody = agentReadableBody(message.body, message.mentions);
    const mentionedUserIds = channelName
      ? message.mentions
          .filter((mention) => mention.kind === "user")
          .map((mention) => mention.actorId)
      : [];
    const sender = message.sender
      ? `@${message.sender.agent?.name ?? message.sender.user?.username ?? "unknown"}`
      : "System";
    const agentId = message.conversation.members[0]?.agentId;
    if (!channelName && !agentId) return null;
    const preview =
      readableBody.length > MESSAGE_PREVIEW_LENGTH
        ? `${readableBody.slice(0, MESSAGE_PREVIEW_LENGTH - 1)}…`
        : readableBody;
    const conversationPath = channelName
      ? `/messages/channels/${message.conversationId}`
      : `/messages/${agentId}`;
    // The message lives in the Chat tab; the server rendering the target never sees the hash.
    const anchoredTarget = `${conversationPath}?view=chat#message-${message.id}`;
    const url = `/notifications/open?workspace=${encodeURIComponent(message.conversation.workspace.slug)}&target=${encodeURIComponent(anchoredTarget)}`;
    return {
      message: {
        id: message.id,
        conversationId: message.conversationId,
        workspaceId: message.workspaceId,
        senderMemberId: message.senderMemberId,
        threadRootId: message.threadRootId,
      },
      channelName,
      mentionedUserIds,
      title: channelName ? `#${channelName}` : sender,
      body: channelName ? `${sender}: ${preview}` : preview,
      url,
      conversationPath,
    };
  }

  /**
   * The one recipient-eligibility rule (not sender, active member, `userId` not null, for channels
   * not muted OR @mentioned OR thread-following, `browserNotificationsEnabled: true`), shared by
   * every read. Passing `userId` narrows it to that one member, for `notificationForRecipient`.
   */
  private recipientWhere(context: MessageContext, userId?: string) {
    const { message, channelName, mentionedUserIds } = context;
    return {
      conversationId: message.conversationId,
      ...(message.senderMemberId ? { id: { not: message.senderMemberId } } : {}),
      userId: userId ?? { not: null },
      ...ACTIVE_MEMBER_WHERE,
      ...(channelName
        ? {
            OR: [
              { channelMuted: false },
              { userId: { in: mentionedUserIds } },
              ...(message.threadRootId
                ? [{ threadFollows: { some: { rootMessageId: message.threadRootId } } }]
                : []),
            ],
          }
        : {}),
      user: { preferences: { browserNotificationsEnabled: true } },
    };
  }

  async notificationForMessage(messageId: string): Promise<MessageWebPushNotification | null> {
    const context = await this.loadMessageContext(messageId);
    if (!context) return null;
    const rows = await this.db.conversationMember.findMany({
      where: this.recipientWhere(context),
      select: {
        userId: true,
        user: {
          select: {
            webPushSubscriptions: {
              select: { id: true, endpoint: true, p256dh: true, auth: true },
            },
          },
        },
      },
    });
    return {
      title: context.title,
      body: context.body,
      url: context.url,
      workspaceId: context.message.workspaceId,
      recipients: rows.map((row) => ({
        userId: row.userId!,
        subscriptions: row.user?.webPushSubscriptions ?? [],
      })),
    };
  }

  async notificationForRecipient(
    messageId: string,
    userId: string,
  ): Promise<RecipientNotification | null> {
    const context = await this.loadMessageContext(messageId);
    if (!context) return null;
    const recipient = await this.db.conversationMember.findFirst({
      where: this.recipientWhere(context, userId),
      select: { id: true },
    });
    if (!recipient) return null;
    return {
      title: context.title,
      body: context.body,
      url: context.url,
      tag: messageNotificationTag(messageId),
      conversationPath: context.conversationPath,
    };
  }

  async subscriptionsForUser(userId: string) {
    return this.db.webPushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  }

  async saveSubscription(userId: string, subscription: WebPushSubscriptionInput) {
    await this.db.webPushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: { userId, ...subscription },
      update: { userId, ...subscription },
    });
  }

  async removeSubscription(userId: string, endpoint: string) {
    await this.db.webPushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  async removeSubscriptionById(id: string) {
    await this.db.webPushSubscription.deleteMany({ where: { id } });
  }
}
