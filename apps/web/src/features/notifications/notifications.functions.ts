import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
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

function context() {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return {
    user,
    db,
    preferences: new UserPreferences(new PrismaUserPreferencesRepository(db)),
    subscriptions: new PrismaWebPushSubscriptionStore(db),
  };
}

export const getBrowserNotificationSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    const { user, preferences } = context();
    return {
      enabled: await preferences.getBrowserNotificationsEnabled(user.id),
      publicKey: readWebPushPublicKey(),
    };
  },
);

export const saveBrowserNotificationPreference = createServerFn({ method: "POST" })
  .validator(browserNotificationPreferenceInput)
  .handler(async ({ data }) => {
    const { user, preferences } = context();
    return {
      enabled: await preferences.setBrowserNotificationsEnabled(user.id, data.enabled),
    };
  });

export const subscribeBrowserPush = createServerFn({ method: "POST" })
  .validator(browserPushSubscriptionInput)
  .handler(async ({ data }) => {
    const { user, subscriptions } = context();
    await subscriptions.saveSubscription(user.id, {
      endpoint: data.endpoint,
      p256dh: data.keys.p256dh,
      auth: data.keys.auth,
      expirationTime: data.expirationTime ? new Date(data.expirationTime) : null,
    });
  });

export const unsubscribeBrowserPush = createServerFn({ method: "POST" })
  .validator(browserPushUnsubscribeInput)
  .handler(async ({ data }) => {
    const { user, subscriptions } = context();
    await subscriptions.removeSubscription(user.id, data.endpoint);
  });

export const sendTestBrowserNotification = createServerFn({ method: "POST" })
  .validator(browserPushTestInput)
  .handler(async ({ data }) => {
    const { user, db, preferences } = context();
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
