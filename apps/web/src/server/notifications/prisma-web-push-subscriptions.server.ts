import type { PrismaClient } from "../../../generated/client";
import { agentReadableBody, mentionedNames } from "../conversations/mentions";
import { ACTIVE_MEMBER_WHERE } from "../conversations/active-member.server";
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
        sender: {
          select: { agent: { select: { name: true } }, user: { select: { username: true } } },
        },
        mentions: { select: { kind: true, actorId: true, handle: true } },
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
    // Stored bodies carry mentions as embedded-UUID tokens; mention-pierce and the preview
    // both work on the plain `@handle` form.
    const readableBody = agentReadableBody(message.body, message.mentions);
    const names = channelName ? mentionedNames(readableBody) : [];
    const recipients = await this.db.conversationMember.findMany({
      where: {
        conversationId: message.conversationId,
        ...(message.senderMemberId ? { id: { not: message.senderMemberId } } : {}),
        userId: { not: null },
        ...ACTIVE_MEMBER_WHERE,
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
        user: { preferences: { browserNotificationsEnabled: true } },
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
    const sender = message.sender
      ? `@${message.sender.agent?.name ?? message.sender.user?.username ?? "unknown"}`
      : "System";
    const agentId = message.conversation.members[0]?.agentId;
    if (!channelName && !agentId) return null;
    const preview =
      readableBody.length > MESSAGE_PREVIEW_LENGTH
        ? `${readableBody.slice(0, MESSAGE_PREVIEW_LENGTH - 1)}…`
        : readableBody;
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
