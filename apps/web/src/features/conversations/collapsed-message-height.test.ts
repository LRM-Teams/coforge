import { describe, expect, test } from "bun:test";

import { collapsedMessageHeightPx, overflowsCollapsedMessage } from "./collapsed-message-height";

describe("collapsed message height", () => {
  test("is thirteen lines of the body's line height at the default message font size", () => {
    expect(collapsedMessageHeightPx(21)).toBe(273);
  });

  test("grows with the line height so a larger Message font size or Text size keeps thirteen lines", () => {
    expect(collapsedMessageHeightPx(24)).toBe(312);
  });

  test("a body collapses only when it is taller than thirteen of its own lines", () => {
    expect(overflowsCollapsedMessage(300, 21)).toBe(true);
    expect(overflowsCollapsedMessage(300, 24)).toBe(false);
    expect(overflowsCollapsedMessage(274, 21)).toBe(false);
  });
});
