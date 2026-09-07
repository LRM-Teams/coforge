import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureBrowserPushSubscription,
  shouldShowAddToHomeScreenGuide,
  unsubscribeCurrentBrowserPush,
} from "../src/features/notifications/browser-push";

const originalNavigator = globalThis.navigator;
const originalNotification = globalThis.Notification;
const originalPushManager = globalThis.PushManager;
const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalNavigator,
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: originalNotification,
  });
  Object.defineProperty(globalThis, "PushManager", {
    configurable: true,
    value: originalPushManager,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

test("shows installation help only in iPhone and iPad Safari outside standalone mode", () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  expect(shouldShowAddToHomeScreenGuide()).toBeTrue();

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    },
  });
  expect(shouldShowAddToHomeScreenGuide()).toBeTrue();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) },
  });
  expect(shouldShowAddToHomeScreenGuide()).toBeFalse();

  for (const userAgent of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/142.0 Mobile/15E148 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/140.0 Mobile/15E148 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  ]) {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent, maxTouchPoints: 5 },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: () => ({ matches: false }) },
    });
    expect(shouldShowAddToHomeScreenGuide()).toBeFalse();
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", maxTouchPoints: 0 },
  });
  expect(shouldShowAddToHomeScreenGuide()).toBeFalse();
});

describe("unsubscribeCurrentBrowserPush", () => {
  test("removes a subscription that finishes registering during sign out", async () => {
    let finishSubscription!: (subscription: PushSubscription) => void;
    const pendingSubscription = new Promise<PushSubscription>((resolve) => {
      finishSubscription = resolve;
    });
    let unsubscribeCalls = 0;
    let subscribeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      subscribeStarted = resolve;
    });
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => {
          subscribeStarted();
          return pendingSubscription;
        },
      },
      getNotifications: async () => [],
    };
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted" },
    });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { Notification: class {}, PushManager: class {} },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          register: async () => registration,
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      },
    });

    const registering = ensureBrowserPushSubscription("AQID");
    await started;
    await unsubscribeCurrentBrowserPush(async () => {
      throw new Error("a late subscription must not reach the server");
    });
    const lateSubscription: PushSubscription = {
      endpoint: "https://fcm.googleapis.com/wp/late",
      expirationTime: null,
      options: { applicationServerKey: null, userVisibleOnly: true },
      getKey: () => null,
      unsubscribe: async () => {
        unsubscribeCalls += 1;
        return true;
      },
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/wp/late",
        expirationTime: null,
        keys: { p256dh: "unused", auth: "unused" },
      }),
    };
    finishSubscription(lateSubscription);

    await expect(registering).rejects.toThrow("registration stopped during sign out");
    expect(unsubscribeCalls).toBe(1);
  });

  test("unsubscribes locally and closes notifications when server cleanup fails", async () => {
    let unsubscribed = false;
    let closed = 0;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: async () => ({
            pushManager: {
              getSubscription: async () => ({
                endpoint: "https://fcm.googleapis.com/wp/current",
                unsubscribe: async () => {
                  unsubscribed = true;
                },
              }),
            },
            getNotifications: async () => [{ close: () => closed++ }, { close: () => closed++ }],
          }),
        },
      },
    });

    await expect(
      unsubscribeCurrentBrowserPush(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(unsubscribed).toBe(true);
    expect(closed).toBe(2);
  });
});
