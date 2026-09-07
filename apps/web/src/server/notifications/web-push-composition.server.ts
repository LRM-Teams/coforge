import type { PrismaClient } from "../../../generated/client";
import { PrismaWebPushSubscriptionStore } from "./prisma-web-push-subscriptions.server";
import { WebPushNotifications } from "./web-push-notifications.server";
import { readWebPushConfig, WebPushLibraryTransport } from "./web-push-transport.server";

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

export function bestEffortMessageNotifier(db: PrismaClient): MessageNotifier {
  return {
    async notifyMessage(messageId) {
      try {
        await (await createWebPushNotifications(db)).notifyMessage(messageId);
      } catch {
        console.warn(JSON.stringify({ event: "web_push.unavailable", messageId }));
      }
    },
  };
}
