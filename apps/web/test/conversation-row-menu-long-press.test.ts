import { expect, test } from "bun:test";

import {
  LONG_PRESS_SLOP_PX,
  longPressAnchorPoint,
  movedBeyondSlop,
  rowClickSuppressed,
} from "../src/features/conversations/conversation-row-menu-model";

/**
 * #128 follow-up to #707: the right-click menu needs a touch entry — on a phone there is no
 * right button, and boss's "记得兼容下移动端" makes long-press the decided form (muse's task
 * text). These pin the gesture's geometry and the click-through rule:
 *
 * - the menu anchors where the finger went down, relative to the row's box (same coordinate
 *   space as the pointer path already uses);
 * - a hold that drifts beyond the slop is a scroll/drag, not a long-press, and must not open;
 * - a click that lands while the menu is open (the release of the long-press itself, or a tap
 *   on the row under an open menu) is swallowed so the row neither navigates nor double-opens.
 */
test("the long-press anchor is the touch point in the row's coordinate space", () => {
  expect(longPressAnchorPoint(140, 90, { left: 100, top: 74 })).toEqual({ left: 40, top: 16 });
});

test("drift within the slop still counts as a hold; beyond it is a scroll", () => {
  const start = { x: 120, y: 80 };
  expect(movedBeyondSlop(start, { x: 120 + LONG_PRESS_SLOP_PX - 1, y: 80 })).toBe(false);
  expect(movedBeyondSlop(start, { x: 120 + LONG_PRESS_SLOP_PX, y: 80 })).toBe(false);
  expect(movedBeyondSlop(start, { x: 120, y: 80 + LONG_PRESS_SLOP_PX + 1 })).toBe(true);
});

test("only a click with the menu open is suppressed", () => {
  expect(rowClickSuppressed(true)).toBe(true);
  expect(rowClickSuppressed(false)).toBe(false);
});
