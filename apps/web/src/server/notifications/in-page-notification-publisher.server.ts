import {
  userConversationChannel,
  type NotificationAvailableEvent,
} from "#src/features/conversations/conversation-realtime";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { NotificationPublisher } from "./web-push-notifications.server";

/**
 * Publishes the bodiless `notification.available.v1` in-page signal to every
 * recipient's own `chat:user:<user_id>` channel in one Centrifugo `broadcast` call, idempotent per
 * message (`notification:<messageId>`, which `broadcast` applies per recipient channel).
 */
export function createCentrifugoNotificationPublisher(
  centrifugo: Pick<CentrifugoServerApi, "broadcast">,
): NotificationPublisher {
  return {
    async notifyRecipients({ messageId, workspaceId, userIds }) {
      if (userIds.length === 0) return;
      const event: NotificationAvailableEvent = {
        type: "notification.available.v1",
        messageId,
        workspaceId,
      };
      await centrifugo.broadcast(
        userIds.map((userId) => userConversationChannel(userId)),
        event,
        `notification:${messageId}`,
      );
    },
  };
}
