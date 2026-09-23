import type { PrismaClient } from "@/generated/prisma/client";
import { isAppError } from "@/lib/app-error";
import { createCentrifugoServerApi } from "@/server/centrifugo/server-api.server";
import { toPublicServerError } from "@/server/errors/public-error.server";
import { createCentrifugoNotificationPublisher } from "./in-page-notification-publisher.server";
import { PrismaWebPushSubscriptionStore } from "./prisma-web-push-subscriptions.server";
import {
  WebPushNotifications,
  type NotificationPublisher,
  type WebPushTransport,
} from "./web-push-notifications.server";
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

/**
 * `createWebPushNotifications` composes both notification paths from one recipient read. Web Push
 * needs a valid VAPID key pair (`readWebPushConfig`); the in-page path does not, and a
 * missing/invalid key pair must not also silence it — deployments without Web Push configured
 * (e.g. local dev) still want in-page notifications. A misconfigured transport degrades to one
 * that fails every delivery, logged here instead of thrown, so a caller that never subscribes for
 * push still gets an in-page notification. Likewise a missing Centrifugo configuration drops only
 * the in-page publication, never Web Push delivery.
 */
export async function createWebPushNotifications(
  db: PrismaClient,
  dependencies: {
    readConfig?: typeof readWebPushConfig;
    publisher?: NotificationPublisher;
  } = {},
) {
  const readConfig = dependencies.readConfig ?? readWebPushConfig;
  let publisher = dependencies.publisher;
  if (!publisher) {
    try {
      publisher = createCentrifugoNotificationPublisher(createCentrifugoServerApi());
    } catch (error) {
      toPublicServerError(error);
    }
  }
  let transport: WebPushTransport;
  try {
    transport = new WebPushLibraryTransport(await readConfig());
  } catch (error) {
    const reported = toPublicServerError(error);
    console.warn(
      JSON.stringify({
        event: "web_push.unconfigured",
        errorId: isAppError(reported) ? reported.errorId : undefined,
      }),
    );
    // A plain Error, not `WebPushDeliveryError(undefined)`: server misconfiguration must stay
    // classified as an ordinary failure (`TEMPORARILY_UNAVAILABLE`), not the browser-facing
    // "push service unreachable" case `deliver()` reserves for a real send attempt that timed out
    // or could not connect.
    transport = {
      async send() {
        throw new Error("Web Push is not configured");
      },
    };
  }
  return new WebPushNotifications(new PrismaWebPushSubscriptionStore(db), transport, publisher);
}

export function bestEffortMessageNotifier(
  db: PrismaClient,
  notifications: (db: PrismaClient) => Promise<MessageNotifier> = createWebPushNotifications,
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
