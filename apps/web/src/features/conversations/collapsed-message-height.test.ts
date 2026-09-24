import { describe, expect, test } from "bun:test";

import { collapsedMessageHeightPx, overflowsCollapsedMessage } from "./collapsed-message-height";

describe("collapsed message height", () => {
  test("is thirteen 24px lines at the default text size", () => {
    expect(collapsedMessageHeightPx(16)).toBe(312);
  });

  test("grows with the root font size so a larger Text size keeps thirteen lines", () => {
    expect(collapsedMessageHeightPx(20)).toBe(390);
  });

  test("a body collapses only when it is taller than the collapsed height at the current text size", () => {
    expect(overflowsCollapsedMessage(340, 16)).toBe(true);
    expect(overflowsCollapsedMessage(340, 20)).toBe(false);
    expect(overflowsCollapsedMessage(313, 16)).toBe(false);
  });
});
