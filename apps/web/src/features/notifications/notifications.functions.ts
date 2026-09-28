import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { authMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "#src/server/db/repositories/user-preferences.repositories.server";
import { AppError, isAppError } from "#src/lib/app-error";
import { extractLocaleFromRequest } from "#src/paraglide/runtime";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import { createWebPushNotifications } from "#src/server/notifications/web-push-composition.server";
import { classifyTestDelivery } from "#src/server/notifications/web-push-notifications.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { readWebPushPublicKey } from "#src/server/notifications/web-push-transport.server";
import {
  browserNotificationPreferenceInput,
  browserPushSubscriptionInput,
  browserPushTestInput,
  browserPushUnsubscribeInput,
  messageNotificationInput,
} from "./notifications.schemas";

function notificationContext(user: { id: string }) {
  const db = requireDatabaseClient();
  return {
    user,
    db,
    preferences: new UserPreferences(new PrismaUserPreferencesRepository(db)),
    subscriptions: new PrismaWebPushSubscriptionStore(db),
  };
}

export const getBrowserNotificationSettings = createServerFn({
  method: "GET",
})
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { user, preferences } = notificationContext(context.user);
    return {
      enabled: await preferences.getBrowserNotificationsEnabled(user.id),
      publicKey: readWebPushPublicKey(),
    };
  });

export const saveBrowserNotificationPreference = createServerFn({
  method: "POST",
})
  .middleware([authMiddleware])
  .validator(browserNotificationPreferenceInput)
  .handler(async ({ data, context }) => {
    const { user, preferences } = notificationContext(context.user);
    return {
      enabled: await preferences.setBrowserNotificationsEnabled(user.id, data.enabled),
    };
  });

export const subscribeBrowserPush = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(browserPushSubscriptionInput)
  .handler(async ({ data, context }) => {
    const { user, subscriptions } = notificationContext(context.user);
    await subscriptions.saveSubscription(user.id, {
      endpoint: data.endpoint,
      p256dh: data.keys.p256dh,
      auth: data.keys.auth,
      expirationTime: data.expirationTime ? new Date(data.expirationTime) : null,
    });
  });

export const unsubscribeBrowserPush = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(browserPushUnsubscribeInput)
  .handler(async ({ data, context }) => {
    const { user, subscriptions } = notificationContext(context.user);
    await subscriptions.removeSubscription(user.id, data.endpoint);
  });

export const sendTestBrowserNotification = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(browserPushTestInput)
  .handler(async ({ data, context }) => {
    const { user, db, preferences } = notificationContext(context.user);
    if (!(await preferences.getBrowserNotificationsEnabled(user.id)))
      throw new AppError("ACCESS_DENIED");
    let result;
    try {
      const sender = await createWebPushNotifications(db);
      result = await sender.sendTest(
        user.id,
        data.endpoint,
        extractLocaleFromRequest(getRequest()),
      );
    } catch (error) {
      // An unusable configuration (bad key pair, missing private key file) or any other refusal:
      // log it with an id the reader's toast can quote.
      const reported = toPublicServerError(error);
      throw new AppError("TEMPORARILY_UNAVAILABLE", {
        errorId: isAppError(reported) ? reported.errorId : undefined,
      });
    }
    const classification = classifyTestDelivery(result);
    // "unreachable" means the push service itself could not be reached (staging in mainland China
    // cannot reach Google's push endpoints for Chrome) — Settings can say that honestly instead of
    // "check this browser's permission". Both failures quote the batch id the delivery log records.
    if (classification === "unreachable")
      throw new AppError("PUSH_SERVICE_UNREACHABLE", { errorId: result.errorId });
    if (classification === "failed")
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: result.errorId });
    return result;
  });

/**
 * The in-page notification read: what `InPageNotifications` fetches once the realtime
 * `notification.available.v1` event tells it a message is worth showing. Authorization is the
 * recipient rule itself — `notificationForRecipient` returns null for a non-recipient, which this
 * handler reports the same as a message the caller cannot see, never distinguishing the two.
 */
export const getMessageNotification = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(messageNotificationInput)
  .handler(async ({ data, context }) => {
    const { user, subscriptions } = notificationContext(context.user);
    return subscriptions.notificationForRecipient(data.messageId, user.id);
  });
