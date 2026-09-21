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
  test("quotes every highlighted line, so a multi-line highlight stays one block", () => {
    expect(formatSelectionQuote("one\ntwo")).toBe("> one\n> two");
  });

  test("an inner blank line becomes a bare quote marker instead of breaking the block", () => {
    expect(formatSelectionQuote("one\n\ntwo")).toBe("> one\n>\n> two");
  });

  test("the quote carries no attribution: the reader can see whose message it is", () => {
    expect(formatSelectionQuote("我觉得是a")).toBe("> 我觉得是a");
  });

  test("a blank selection quotes nothing", () => {
    expect(formatSelectionQuote("   \n  ")).toBe("");
  });

  test("trailing space inside a highlighted line is trimmed per line", () => {
    expect(formatSelectionQuote("one  \ntwo ")).toBe("> one\n> two");
  });
});
