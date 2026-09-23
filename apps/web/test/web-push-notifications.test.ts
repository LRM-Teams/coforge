import { describe, expect, spyOn, test } from "bun:test";

import {
  WebPushDeliveryError,
  WebPushNotifications,
  type WebPushSubscriptionStore,
  type WebPushTransport,
} from "../src/server/notifications/web-push-notifications.server";

const first = {
  id: "subscription-a",
  endpoint: "https://fcm.googleapis.com/wp/subscription-a",
  p256dh: "public-a",
  auth: "auth-a",
};
const second = {
  id: "subscription-b",
  endpoint: "https://updates.push.services.mozilla.com/wpush/v2/subscription-b",
  p256dh: "public-b",
  auth: "auth-b",
};

function store(input?: {
  message?: Awaited<ReturnType<WebPushSubscriptionStore["notificationForMessage"]>>;
  subscriptions?: (typeof first)[];
}) {
  const removed: string[] = [];
  const saved: Array<{ userId: string; endpoint: string }> = [];
  const value: WebPushSubscriptionStore = {
    notificationForMessage: async () => input?.message ?? null,
    subscriptionsForUser: async () => input?.subscriptions ?? [],
    saveSubscription: async (userId, subscription) => {
      saved.push({ userId, endpoint: subscription.endpoint });
    },
    removeSubscription: async (userId, endpoint) => {
      removed.push(`${userId}:${endpoint}`);
    },
    removeSubscriptionById: async (id) => {
      removed.push(id);
    },
  };
  return { value, removed, saved };
}

describe("WebPushNotifications", () => {
  test("delivers a committed message to every eligible browser subscription", async () => {
    const sent: Array<{ id: string; payload: unknown }> = [];
    const repository = store({
      message: {
        title: "#general",
        body: "@helper: Build finished",
        url: "/messages/channels/channel-a#message-message-a",
        subscriptions: [first, second],
      },
    });
    const transport: WebPushTransport = {
      send: async (subscription, payload) => {
        sent.push({ id: subscription.id, payload });
      },
    };

    const result = await new WebPushNotifications(repository.value, transport).notifyMessage(
      "message-a",
    );

    expect(result).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(sent).toEqual([
      {
        id: "subscription-a",
        payload: {
          title: "#general",
          body: "@helper: Build finished",
          url: "/messages/channels/channel-a#message-message-a",
          tag: "message:message-a",
        },
      },
      {
        id: "subscription-b",
        payload: {
          title: "#general",
          body: "@helper: Build finished",
          url: "/messages/channels/channel-a#message-message-a",
          tag: "message:message-a",
        },
      },
    ]);
  });

  test("removes expired subscriptions without failing canonical message delivery", async () => {
    const repository = store({
      message: {
        title: "@helper",
        body: "Ready",
        url: "/messages/agent-a",
        subscriptions: [first, second],
      },
    });
    const transport: WebPushTransport = {
      send: async (subscription) => {
        if (subscription.id === first.id) throw new WebPushDeliveryError(410);
        throw new WebPushDeliveryError(503);
      },
    };

    const result = await new WebPushNotifications(repository.value, transport).notifyMessage(
      "message-a",
    );

    expect(result).toEqual({ sent: 0, failed: 1, removed: 1, errorId: expect.any(String) });
    expect(repository.removed).toEqual([first.id]);
  });

  test("a removed subscription leaves a trace in the log", async () => {
    // Observed 2026-09-22: a member saw only "check this browser's permission" while the server log
    // said nothing, because a pruned subscription was never logged.
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const repository = store({ subscriptions: [first] });
      const notifications = new WebPushNotifications(repository.value, {
        send: async () => {
          throw new WebPushDeliveryError(410);
        },
      });

      await expect(notifications.sendTest("user-a", first.endpoint, "en")).resolves.toEqual({
        sent: 0,
        failed: 0,
        removed: 1,
        errorId: expect.any(String),
      });
      const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("web_push.subscription_removed");
      expect(logged).toContain(first.id);
      // Never the endpoint: it is a capability URL.
      expect(logged).not.toContain(first.endpoint);
    } finally {
      error.mockRestore();
    }
  });

  test("uses the production delivery path for a test notification", async () => {
    const repository = store({ subscriptions: [first] });
    const payloads: Array<{ title: string; forceDisplay?: boolean }> = [];
    const notifications = new WebPushNotifications(repository.value, {
      send: async (_subscription, payload) => {
        payloads.push(payload);
      },
    });

    await expect(notifications.sendTest("user-a", first.endpoint, "en")).resolves.toEqual({
      sent: 1,
      failed: 0,
      removed: 0,
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        title: "CoForge",
        forceDisplay: true,
        url: "/settings",
      }),
    ]);
  });

  test("localizes the test notification to the reader's locale", async () => {
    const bodies: string[] = [];
    const repository = store({ subscriptions: [first] });
    const notifications = new WebPushNotifications(repository.value, {
      send: async (_subscription, payload) => {
        bodies.push(payload.body);
      },
    });

    await notifications.sendTest("user-a", first.endpoint, "zh-CN");
    expect(bodies).toEqual(["此设备上的浏览器通知正常工作。"]);
  });

  test("associates and detaches only the authenticated user's browser subscription", async () => {
    const repository = store();
    const notifications = new WebPushNotifications(repository.value, {
      send: async () => {},
    });

    await notifications.subscribe("user-a", {
      endpoint: first.endpoint,
      p256dh: first.p256dh,
      auth: first.auth,
      expirationTime: null,
    });
    await notifications.unsubscribe("user-a", first.endpoint);

    expect(repository.saved).toEqual([{ userId: "user-a", endpoint: first.endpoint }]);
    expect(repository.removed).toEqual([`user-a:${first.endpoint}`]);
  });
});
