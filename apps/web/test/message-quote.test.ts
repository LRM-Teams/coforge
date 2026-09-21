import { describe, expect, test } from "bun:test";

import {
  QUOTE_SELECTION_MAX_CHARS,
  formatSelectionQuote,
  quoteSelectionText,
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
