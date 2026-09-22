import { expect, test } from "bun:test";

import { swallowNextClick } from "../src/utils/swallow-next-click";

test("swallows exactly the next click, and no later one", () => {
  const target = new EventTarget();
  swallowNextClick(target);

  const stopped = new Event("click", { cancelable: true });
  target.dispatchEvent(stopped);
  expect(stopped.defaultPrevented).toBe(true);

  const later = new Event("click", { cancelable: true });
  target.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

test("gives up after its expiry, so a keyboard pick never leaves a click swallowed", async () => {
  const target = new EventTarget();
  swallowNextClick(target, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const later = new Event("click", { cancelable: true });
  target.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});
