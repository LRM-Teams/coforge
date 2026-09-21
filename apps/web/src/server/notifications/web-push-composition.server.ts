import type { PrismaClient } from "../../../generated/client";
import { PrismaWebPushSubscriptionStore } from "./prisma-web-push-subscriptions.server";
import { WebPushNotifications } from "./web-push-notifications.server";
import { readWebPushConfig, WebPushLibraryTransport } from "./web-push-transport.server";

/**
 * A message notifier starts best-effort Web Push delivery and returns before
 * that delivery completes. Callers on the message send path may await
 * `notifyMessage` without the response waiting on push delivery; delivery
 * failures are only logged in the background.
 */
export type MessageNotifier = {
  notifyMessage(messageId: string): Promise<unknown>;
};

export async function createWebPushNotifications(db: PrismaClient) {
  const config = await readWebPushConfig();
  return new WebPushNotifications(
    new PrismaWebPushSubscriptionStore(db),
    new WebPushLibraryTransport(config),
  );
}

export function bestEffortMessageNotifier(
  db: PrismaClient,
  notifications: (
    db: PrismaClient,
  ) => Promise<{ notifyMessage(messageId: string): Promise<unknown> }> = createWebPushNotifications,
): MessageNotifier {
  return {
    async notifyMessage(messageId) {
      void (async () => {
        try {
          await (await notifications(db)).notifyMessage(messageId);
        } catch {
          console.warn(JSON.stringify({ event: "web_push.unavailable", messageId }));
        }
      })();
    },
  };
}
