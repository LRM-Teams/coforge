import type { PrismaClient } from "../../../generated/client";
import { mentionedNames } from "../conversations/mentions";
import type {
  WebPushSubscriptionInput,
  WebPushSubscriptionStore,
} from "./web-push-notifications.server";

const MESSAGE_PREVIEW_LENGTH = 180;

export class PrismaWebPushSubscriptionStore implements WebPushSubscriptionStore {
  constructor(private readonly db: PrismaClient) {}

  async notificationForMessage(messageId: string) {
    const message = await this.db.message.findUnique({
      where: { id: messageId },
      include: {
        sender: { include: { user: true, agent: true } },
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
    const names = channelName ? mentionedNames(message.body) : [];
    const recipients = await this.db.conversationMember.findMany({
      where: {
        conversationId: message.conversationId,
        id: { not: message.senderMemberId },
        userId: { not: null },
        ...(channelName
          ? {
              OR: [
                { channelMuted: false },
                { user: { username: { in: names } } },
                ...(message.threadRootId
                  ? [{ threadFollows: { some: { rootMessageId: message.threadRootId } } }]
                  : []),
              ],
            }
          : {}),
        user: { browserNotificationsEnabled: true },
      },
      select: {
        user: {
          select: {
            webPushSubscriptions: {
              select: { id: true, endpoint: true, p256dh: true, auth: true },
            },
          },
        },
      },
    });
    const sender = `@${message.sender.agent?.name ?? message.sender.user?.username ?? "unknown"}`;
    const agentId = message.conversation.members[0]?.agentId;
    if (!channelName && !agentId) return null;
    const preview =
      message.body.length > MESSAGE_PREVIEW_LENGTH
        ? `${message.body.slice(0, MESSAGE_PREVIEW_LENGTH - 1)}…`
        : message.body;
    const target = channelName
      ? `/messages/channels/${message.conversationId}`
      : `/messages/${agentId}`;
    const anchoredTarget = `${target}#message-${message.id}`;
    const url = `/notifications/open?workspace=${encodeURIComponent(message.conversation.workspace.slug)}&target=${encodeURIComponent(anchoredTarget)}`;
    return {
      title: channelName ? `#${channelName}` : sender,
      body: channelName ? `${sender}: ${preview}` : preview,
      url,
      subscriptions: recipients.flatMap((recipient) => recipient.user?.webPushSubscriptions ?? []),
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
