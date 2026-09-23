import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  bestEffortMessageNotifier,
  createWebPushNotifications,
} from "@/server/notifications/web-push-composition.server";

const db = {} as PrismaClient;

describe("createWebPushNotifications", () => {
  test("degrades Web Push delivery to an ordinary failure when VAPID is not configured, instead of throwing", async () => {
    // Local dev without a VAPID key pair must still be able to show in-page notifications (ADR
    // 0065); only Web Push delivery itself should degrade, and as `failed` (not the
    // `unreachable`/PUSH_SERVICE_UNREACHABLE bucket `deliver()` reserves for a real send attempt
    // that could not connect).
    const fakeDb = {
      webPushSubscription: {
        findMany: async () => [
          {
            id: "subscription-a",
            endpoint: "https://fcm.googleapis.com/wp/subscription-a",
            p256dh: "public-a",
            auth: "auth-a",
          },
        ],
      },
    } as unknown as PrismaClient;

    const notifications = await createWebPushNotifications(fakeDb, {
      readConfig: async () => {
        throw new Error("VAPID key pair is not configured");
      },
      publisher: { notifyRecipients: async () => {} },
    });

    await expect(
      notifications.sendTest("user-a", "https://fcm.googleapis.com/wp/subscription-a", "en"),
    ).resolves.toEqual({
      sent: 0,
      failed: 1,
      removed: 0,
      unreachable: 0,
      errorId: expect.any(String),
    });
  });
});

describe("bestEffortMessageNotifier", () => {
  test("resolves promptly even when delivery never settles", async () => {
    const notifier = bestEffortMessageNotifier(db, async () => ({
      notifyMessage: () => new Promise(() => {}),
    }));

    await expect(notifier.notifyMessage("message-a")).resolves.toBeUndefined();
  });

  describe("when background delivery fails", () => {
    let warn: ReturnType<typeof spyOn<Console, "warn">>;

    beforeEach(() => {
      warn = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    test("still resolves and logs web_push.unavailable in the background", async () => {
      let releaseFailure!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, reject) => {
        releaseFailure = reject;
      });
      let warned!: () => void;
      const warnedOnce = new Promise<void>((resolve) => {
        warned = resolve;
      });
      warn.mockImplementation(() => {
        warned();
      });

      const notifier = bestEffortMessageNotifier(db, async () => ({
        notifyMessage: () => failure,
      }));

      await expect(notifier.notifyMessage("message-a")).resolves.toBeUndefined();

      releaseFailure(new Error("delivery unavailable"));
      await warnedOnce;

      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({ event: "web_push.unavailable", messageId: "message-a" }),
      );
    });
  });
});
