import { expect, test } from "bun:test";

import { browserPushSubscriptionInput } from "../src/features/notifications/notifications.schemas";

const subscription = {
  endpoint: "https://push.example/subscription",
  expirationTime: null,
  keys: {
    p256dh: "A".repeat(87),
    auth: "A".repeat(22),
  },
};

test("accepts opaque HTTPS push endpoints supplied by the browser", () => {
  expect(browserPushSubscriptionInput.safeParse(subscription).success).toBeTrue();
  for (const endpoint of [
    "https://jmt17.google.com/fcm/send/subscription",
    "https://web.push.apple.com/subscription",
  ]) {
    expect(
      browserPushSubscriptionInput.safeParse({ ...subscription, endpoint }).success,
    ).toBeTrue();
  }
});

test("rejects push endpoints that are not safe absolute HTTPS URLs", () => {
  for (const endpoint of [
    "http://push.example/subscription",
    "https://user:password@push.example/subscription",
    "https://push.example/subscription#fragment",
    "https:localhost/subscription",
    "/subscription",
  ]) {
    expect(
      browserPushSubscriptionInput.safeParse({ ...subscription, endpoint }).success,
    ).toBeFalse();
  }
});
