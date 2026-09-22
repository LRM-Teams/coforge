import { expect, test } from "bun:test";

import { PENDING_DELAY_MS, PENDING_MIN_MS } from "@/lib/pending-policy";
import { getRouter } from "@/router";

test("the router carries the one pending policy, so no route has to restate it", () => {
  const router = getRouter();
  expect(router.options.defaultPendingMs).toBe(PENDING_DELAY_MS);
  expect(router.options.defaultPendingMinMs).toBe(PENDING_MIN_MS);
});

test("a fallback that appears at the delay line stays long enough not to flash", () => {
  // Opening a channel whose load crossed the delay showed the skeleton for a split second
  // (#112/#113): the delay only helps if the minimum keeps it up once it appears.
  expect(PENDING_MIN_MS).toBeGreaterThanOrEqual(PENDING_DELAY_MS);
});
