import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../../server/auth/function-auth";
import { requireDatabaseClient } from "../../server/db/client.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "../../server/db/repositories/user-preferences.repositories.server";
import { AppError } from "../../lib/app-error";
import { createWebPushNotifications } from "../../server/notifications/web-push-composition.server";
import { PrismaWebPushSubscriptionStore } from "../../server/notifications/prisma-web-push-subscriptions.server";
import { readWebPushPublicKey } from "../../server/notifications/web-push-transport.server";
import {
  browserNotificationPreferenceInput,
  browserPushSubscriptionInput,
  browserPushTestInput,
  browserPushUnsubscribeInput,
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
    try {
      const result = await (await createWebPushNotifications(db)).sendTest(user.id, data.endpoint);
      if (result.sent === 0) throw new AppError("TEMPORARILY_UNAVAILABLE");
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    }
  });
