import { expect, test } from "bun:test";

import { streamMovedSince, subscriptionGap } from "#src/features/realtime/subscription-gap";

test("a subscribe that did not recover is a first read of the channel", () => {
  // Also every resubscribe on a namespace without history, such as `agent:`.
  expect(subscriptionGap({ wasRecovering: false, recovered: false })).toBe("unrecovered");
});

test("a resubscribe whose stream could not be replayed lost publications", () => {
  expect(subscriptionGap({ wasRecovering: true, recovered: false })).toBe("lost");
});

test("a resubscribe that replayed every missed publication missed nothing", () => {
  expect(subscriptionGap({ wasRecovering: true, recovered: true })).toBe("none");
});

test("a read at or after the subscription's position missed nothing it will not deliver", () => {
  const subscribed = { offset: 7, epoch: "e1" };
  expect(streamMovedSince({ offset: 7, epoch: "e1" }, subscribed)).toBe(false);
  expect(streamMovedSince({ offset: 9, epoch: "e1" }, subscribed)).toBe(false);
});

test("a read before the subscription's position, in another epoch, or without one may have missed", () => {
  const subscribed = { offset: 7, epoch: "e1" };
  expect(streamMovedSince({ offset: 6, epoch: "e1" }, subscribed)).toBe(true);
  expect(streamMovedSince({ offset: 7, epoch: "e0" }, subscribed)).toBe(true);
  expect(streamMovedSince(undefined, subscribed)).toBe(true);
  expect(streamMovedSince({ offset: 7, epoch: "e1" }, undefined)).toBe(true);
});
