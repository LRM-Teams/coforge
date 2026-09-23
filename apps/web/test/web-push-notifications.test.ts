import { describe, expect, spyOn, test } from "bun:test";

import {
  WebPushDeliveryError,
  WebPushNotifications,
  classifyTestDelivery,
  messageNotificationTag,
  type NotificationPublisher,
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
    notificationForRecipient: async () => null,
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
        workspaceId: "workspace-a",
        recipients: [
          { userId: "alice", subscriptions: [first] },
          { userId: "bob", subscriptions: [second] },
        ],
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

    expect(result).toEqual({ sent: 2, failed: 0, removed: 0, unreachable: 0 });
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

  test("a recipient without a browser subscription is still counted a recipient", async () => {
    const repository = store({
      message: {
        title: "#general",
        body: "@helper: Build finished",
        url: "/messages/channels/channel-a#message-message-a",
        workspaceId: "workspace-a",
        recipients: [{ userId: "alice", subscriptions: [] }],
      },
    });
    const publisher: NotificationPublisher = {
      notifyRecipients: async () => {},
    };
    const seen: Array<{ messageId: string; workspaceId: string; userIds: readonly string[] }> = [];
    publisher.notifyRecipients = async (input) => {
      seen.push(input);
    };

    const result = await new WebPushNotifications(
      repository.value,
      { send: async () => {} },
      publisher,
    ).notifyMessage("message-a");

    expect(result).toEqual({ sent: 0, failed: 0, removed: 0, unreachable: 0 });
    expect(seen).toEqual([
      { messageId: "message-a", workspaceId: "workspace-a", userIds: ["alice"] },
    ]);
  });

  test("logs a publish failure without failing message delivery", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const repository = store({
        message: {
          title: "#general",
          body: "@helper: Build finished",
          url: "/messages/channels/channel-a#message-message-a",
          workspaceId: "workspace-a",
          recipients: [{ userId: "alice", subscriptions: [first] }],
        },
      });
      const publisher: NotificationPublisher = {
        notifyRecipients: async () => {
          throw new Error("centrifugo unreachable");
        },
      };
      const transport: WebPushTransport = { send: async () => {} };

      const result = await new WebPushNotifications(
        repository.value,
        transport,
        publisher,
      ).notifyMessage("message-a");

      expect(result).toEqual({ sent: 1, failed: 0, removed: 0, unreachable: 0 });
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("in_page_notification.unavailable");
      expect(logged).toContain("message-a");
    } finally {
      warn.mockRestore();
    }
  });

  test("removes expired subscriptions without failing canonical message delivery", async () => {
    const repository = store({
      message: {
        title: "@helper",
        body: "Ready",
        url: "/messages/agent-a",
        workspaceId: "workspace-a",
        recipients: [
          { userId: "alice", subscriptions: [first] },
          { userId: "bob", subscriptions: [second] },
        ],
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

    expect(result).toEqual({
      sent: 0,
      failed: 1,
      removed: 1,
      unreachable: 0,
      errorId: expect.any(String),
    });
    expect(repository.removed).toEqual([first.id]);
  });

  test("classifies a connection failure (no status code) as push-service-unreachable", async () => {
    const repository = store({
      message: {
        title: "@helper",
        body: "Ready",
        url: "/messages/agent-a",
        workspaceId: "workspace-a",
        recipients: [{ userId: "alice", subscriptions: [first] }],
      },
    });
    const transport: WebPushTransport = {
      send: async () => {
        throw new WebPushDeliveryError(undefined);
      },
    };

    const result = await new WebPushNotifications(repository.value, transport).notifyMessage(
      "message-a",
    );

    expect(result).toEqual({
      sent: 0,
      failed: 0,
      removed: 0,
      unreachable: 1,
      errorId: expect.any(String),
    });
  });

  test("exposes the shared message notification tag format", () => {
    expect(messageNotificationTag("message-a")).toBe("message:message-a");
  });

  describe("classifyTestDelivery", () => {
    test("sent whenever at least one device received it", () => {
      expect(classifyTestDelivery({ sent: 1, failed: 1, removed: 1, unreachable: 1 })).toBe("sent");
    });

    test("unreachable only when every attempted delivery failed that exact way", () => {
      expect(classifyTestDelivery({ sent: 0, failed: 0, removed: 0, unreachable: 1 })).toBe(
        "unreachable",
      );
    });

    test("failed when a removed or ordinary failure is mixed in, even alongside unreachable ones", () => {
      expect(classifyTestDelivery({ sent: 0, failed: 0, removed: 1, unreachable: 1 })).toBe(
        "failed",
      );
      expect(classifyTestDelivery({ sent: 0, failed: 1, removed: 0, unreachable: 1 })).toBe(
        "failed",
      );
      expect(classifyTestDelivery({ sent: 0, failed: 1, removed: 0, unreachable: 0 })).toBe(
        "failed",
      );
    });
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
        unreachable: 0,
      });
      const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("web_push.subscription_removed");
      expect(logged).toContain(first.id);
      // docs/observability.md: an error-level event must carry `outcome=failed` (#681 review).
      expect(logged).toContain('"outcome":"failed"');
      // Never the endpoint: it is a capability URL.
      expect(logged).not.toContain(first.endpoint);
    } finally {
      error.mockRestore();
    }
  });

  test("an ordinary delivery failure logs outcome=failed with its errorId", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const repository = store({ subscriptions: [first] });
      const notifications = new WebPushNotifications(repository.value, {
        send: async () => {
          throw new WebPushDeliveryError(500);
        },
      });
      await expect(notifications.sendTest("user-a", first.endpoint, "en")).resolves.toEqual({
        sent: 0,
        failed: 1,
        removed: 0,
        errorId: expect.any(String),
        unreachable: 0,
      });
      const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("web_push.delivery_failed");
      // The stable event + correlatable errorId already satisfy the rest of the contract;
      // this is the field #681's review asked to fold in.
      expect(logged).toContain('"outcome":"failed"');
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
      unreachable: 0,
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
