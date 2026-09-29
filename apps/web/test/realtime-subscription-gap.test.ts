import { expect, test } from "bun:test";

import { subscriptionGap } from "#src/features/realtime/subscription-gap";

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
