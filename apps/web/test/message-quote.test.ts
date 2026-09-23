import { describe, expect, test } from "bun:test";

import {
  AFFORDANCE_HEIGHT,
  AFFORDANCE_WIDTH,
  QUOTE_SELECTION_MAX_CHARS,
  TOUCH_AFFORDANCE_GAP,
  formatSelectionQuote,
  quoteSelectionText,
  selectionAffordancePlacement,
} from "../src/features/conversations/message-quote";

describe("quoteSelectionText", () => {
  test("drops the blank space the browser includes around a highlight", () => {
    expect(quoteSelectionText("  hello there \n")).toBe("hello there");
  });

  test("keeps inner lines and blank lines as written", () => {
    expect(quoteSelectionText("first\n\nsecond")).toBe("first\n\nsecond");
  });

  test("cuts a highlight longer than the bound and marks the cut", () => {
    const long = "x".repeat(QUOTE_SELECTION_MAX_CHARS + 40);
    const cut = quoteSelectionText(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBe(QUOTE_SELECTION_MAX_CHARS + 1);
  });

  test("a highlight exactly at the bound is kept whole", () => {
    const exact = "y".repeat(QUOTE_SELECTION_MAX_CHARS);
    expect(quoteSelectionText(exact)).toBe(exact);
  });
});

describe("formatSelectionQuote", () => {
  const source = { author: "Alice", time: "10:32" };

  test("credits the message's author and clock on the quote's first line", () => {
    expect(formatSelectionQuote(source, "我觉得是a")).toBe("> **Alice** 10:32:\n> 我觉得是a");
  });

  test("quotes every highlighted line, so a multi-line highlight stays one block", () => {
    expect(formatSelectionQuote(source, "one\ntwo")).toBe("> **Alice** 10:32:\n> one\n> two");
  });

  test("an inner blank line becomes a bare quote marker instead of breaking the block", () => {
    expect(formatSelectionQuote(source, "one\n\ntwo")).toBe("> **Alice** 10:32:\n> one\n>\n> two");
  });

  test("a blank selection quotes nothing", () => {
    expect(formatSelectionQuote(source, "   \n  ")).toBe("");
  });

  test("no author (a server-authored message) leaves the quote without a credit line", () => {
    expect(formatSelectionQuote({ author: "  ", time: "10:32" }, "notice")).toBe("> notice");
  });

  test("no clock label still credits the author", () => {
    expect(formatSelectionQuote({ author: "Alice", time: "" }, "hi")).toBe("> **Alice**:\n> hi");
  });

  test("trailing space inside a highlighted line is trimmed per line", () => {
    expect(formatSelectionQuote(source, "one  \ntwo ")).toBe("> **Alice** 10:32:\n> one\n> two");
  });
});

describe("selectionAffordancePlacement", () => {
  // The body box the affordance is absolutely positioned inside, and a highlight in it.
  const container = { top: 100, right: 620, bottom: 300, left: 20, width: 600, height: 200 };
  const highlight = { top: 140, right: 300, bottom: 164, left: 40, width: 260, height: 24 };

  test("floats above the highlight, so it never covers the text that follows the selection", () => {
    const placement = selectionAffordancePlacement(highlight, container);
    // 40 (highlight's top inside the body) minus the affordance's own height and a small gap.
    expect(placement.top).toBe(40 - AFFORDANCE_HEIGHT - 4);
    expect(placement.top + AFFORDANCE_HEIGHT).toBeLessThan(highlight.top - container.top);
  });

  test("stays above the highlight on the body's first line, overflowing over the row header", () => {
    const firstLine = { ...highlight, top: 100, bottom: 124 };
    // No boundary given: never clamp into the body — above the highlight means above it, even
    // when that renders over the sender header above the body.
    expect(selectionAffordancePlacement(firstLine, container).top).toBe(-AFFORDANCE_HEIGHT - 4);
  });

  test("flips below the highlight only when above would cross the visible boundary's top", () => {
    const firstLine = { ...highlight, top: 100, bottom: 124 };
    // The visible history starts at the body's top edge: 64 < 100, so above does not fit.
    const placement = selectionAffordancePlacement(firstLine, container, { top: 100 });
    expect(placement.top).toBe(124 - 100 + 4);
  });

  test("stays above when above fits the boundary, even though it overflows the body", () => {
    const firstLine = { ...highlight, top: 100, bottom: 124 };
    const placement = selectionAffordancePlacement(firstLine, container, { top: 0 });
    expect(placement.top).toBe(-AFFORDANCE_HEIGHT - 4);
  });

  // A touch selection raises the platform's own edit menu above the highlight (iOS Copy/Look Up,
  // Android's selection toolbar), and web content cannot suppress it: the bar goes below instead,
  // clear of the selection's end handle, so the two menus never stack.
  test("a touch selection puts the bar below the highlight, clear of the end handle", () => {
    const placement = selectionAffordancePlacement(highlight, container, undefined, "below");
    expect(placement.top).toBe(164 - 100 + TOUCH_AFFORDANCE_GAP);
  });

  test("a touch selection flips above only when below would cross the visible bottom", () => {
    const lastLine = { ...highlight, top: 276, bottom: 300 };
    const placement = selectionAffordancePlacement(
      lastLine,
      container,
      { top: 0, bottom: 320 },
      "below",
    );
    expect(placement.top).toBe(276 - 100 - AFFORDANCE_HEIGHT - 4);
  });

  test("a touch selection stays below when below fits the visible bottom", () => {
    const placement = selectionAffordancePlacement(
      highlight,
      container,
      { top: 0, bottom: 320 },
      "below",
    );
    expect(placement.top).toBe(164 - 100 + TOUCH_AFFORDANCE_GAP);
  });

  test("a mouse selection ignores the visible bottom while above fits", () => {
    const lastLine = { ...highlight, top: 276, bottom: 300 };
    const placement = selectionAffordancePlacement(lastLine, container, { top: 0, bottom: 320 });
    expect(placement.top).toBe(276 - 100 - AFFORDANCE_HEIGHT - 4);
  });

  test("a touch selection stays below when the bar ends exactly on the visible bottom", () => {
    const bottom = 164 + TOUCH_AFFORDANCE_GAP + AFFORDANCE_HEIGHT;
    const placement = selectionAffordancePlacement(
      highlight,
      container,
      { top: 0, bottom },
      "below",
    );
    expect(placement.top).toBe(164 - 100 + TOUCH_AFFORDANCE_GAP);
  });

  // A highlight taller than the visible history (a long selection dragged to the screen's edge)
  // leaves room on neither side: the bar keeps its side but stays inside the visible region.
  test("a touch selection with room on neither side pins the bar to the visible bottom", () => {
    const tall = { ...highlight, top: 110, bottom: 318, height: 208 };
    const placement = selectionAffordancePlacement(
      tall,
      container,
      { top: 120, bottom: 320 },
      "below",
    );
    expect(placement.top).toBe(320 - AFFORDANCE_HEIGHT - 100);
  });

  test("a mouse selection with room on neither side pins the bar to the visible top", () => {
    const tall = { ...highlight, top: 110, bottom: 318, height: 208 };
    const placement = selectionAffordancePlacement(tall, container, { top: 120, bottom: 320 });
    expect(placement.top).toBe(120 - 100);
  });

  test("centers over the highlight when there is room", () => {
    // 150 (highlight's horizontal center inside the body) minus half the affordance.
    expect(selectionAffordancePlacement(highlight, container).left).toBe(
      150 - AFFORDANCE_WIDTH / 2,
    );
  });

  test("clamps to the body's left edge when centering would overflow it", () => {
    const flushLeft = { ...highlight, right: 44, left: 20, width: 24 };
    expect(selectionAffordancePlacement(flushLeft, container).left).toBe(0);
  });

  test("clamps to the body's right edge when centering would overflow it", () => {
    const flushRight = { ...highlight, left: 596, width: 24 };
    expect(selectionAffordancePlacement(flushRight, container).left).toBe(
      container.width - AFFORDANCE_WIDTH,
    );
  });
});
