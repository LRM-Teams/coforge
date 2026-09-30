import { expect, test } from "bun:test";

import {
  olderStreamPositions,
  streamMovedSince,
  subscriptionGap,
} from "#src/features/realtime/subscription-gap";

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

test("a list built from two reads is as fresh as the older of them, per channel", () => {
  expect(
    olderStreamPositions(
      {
        "chat:user:u1": { offset: 9, epoch: "e1" },
        "chat:workspace:w1": { offset: 2, epoch: "e1" },
      },
      {
        "chat:user:u1": { offset: 7, epoch: "e1" },
        "chat:workspace:w1": { offset: 5, epoch: "e1" },
      },
    ),
  ).toEqual({
    "chat:user:u1": { offset: 7, epoch: "e1" },
    "chat:workspace:w1": { offset: 2, epoch: "e1" },
  });
});

test("reads in different epochs, or a channel only one read has, leave no position for it", () => {
  expect(
    olderStreamPositions(
      { "chat:user:u1": { offset: 9, epoch: "e2" }, "chat:user:u2": { offset: 1, epoch: "e1" } },
      { "chat:user:u1": { offset: 7, epoch: "e1" } },
    ),
  ).toEqual({});
  expect(olderStreamPositions({ "chat:user:u1": { offset: 1, epoch: "e1" } }, {})).toEqual({});
});
