import { expect, test } from "bun:test";

import { PENDING_DELAY_MS, PENDING_MIN_MS } from "#src/lib/pending-policy";
import { getRouter } from "#src/router";

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

test("Chat's layout is the one route without the minimum: its loading screen is server-sent", async () => {
  // Chat renders in the browser only (`ssr: false`), so its fallback is already on screen from the
  // first paint; the router starts the minimum again at hydration, which held a page opened from
  // the browser's stored copy ~300 ms after its data was there.
  const { Route } = await import("#src/routes/w.$workspaceSlug/_chat");
  expect(Route.options.pendingMinMs).toBe(0);
});
