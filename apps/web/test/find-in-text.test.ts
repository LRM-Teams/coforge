import { expect, test } from "bun:test";
import { findMatches, FIND_MATCH_CAP } from "#src/features/projects/find-in-text";
import {
  splitHighlightedLines,
  splitPlainLines,
} from "#src/features/projects/split-highlighted-lines";

test("is case-insensitive by default", () => {
  expect(findMatches("Foo foo FOO", "foo")).toEqual([
    { line: 1, start: 0, end: 3 },
    { line: 1, start: 4, end: 7 },
    { line: 1, start: 8, end: 11 },
  ]);
});

test("case-sensitive mode only matches the exact case", () => {
  expect(findMatches("Foo foo FOO", "foo", { caseSensitive: true })).toEqual([
    { line: 1, start: 4, end: 7 },
  ]);
});

test("finds multiple matches per line with correct offsets", () => {
  expect(findMatches("cat cat cat", "cat")).toEqual([
    { line: 1, start: 0, end: 3 },
    { line: 1, start: 4, end: 7 },
    { line: 1, start: 8, end: 11 },
  ]);
});

test("matches do not overlap", () => {
  expect(findMatches("aaa", "aa")).toEqual([{ line: 1, start: 0, end: 2 }]);
  expect(findMatches("aaaa", "aa")).toEqual([
    { line: 1, start: 0, end: 2 },
    { line: 1, start: 2, end: 4 },
  ]);
});

test("an empty query returns no matches", () => {
  expect(findMatches("hello", "")).toEqual([]);
});

test("matches span multiple lines with 1-based line numbers", () => {
  expect(findMatches("foo\nbar\nfoo", "foo")).toEqual([
    { line: 1, start: 0, end: 3 },
    { line: 3, start: 0, end: 3 },
  ]);
});

test("caps collection at FIND_MATCH_CAP", () => {
  const text = "a".repeat(FIND_MATCH_CAP + 500);
  const matches = findMatches(text, "a");
  expect(matches.length).toBe(FIND_MATCH_CAP);
});

test("CRLF: findMatches line numbers agree with splitHighlightedLines' line count and content", () => {
  const crlf = "one\r\ntwo needle\r\nthree\r\n";

  // splitPlainLines is what findMatches indexes against.
  const plainLines = splitPlainLines(crlf);

  // splitHighlightedLines is what the code view actually renders (a plain
  // text node here, so no highlighting spans get in the way of comparing).
  const renderedLines = splitHighlightedLines({
    type: "root",
    children: [{ type: "text", value: crlf }],
  });

  expect(plainLines).toEqual(renderedLines);
  expect(plainLines).toEqual(["one\r", "two needle\r", "three\r"]);

  const matches = findMatches(crlf, "needle");
  expect(matches).toEqual([{ line: 2, start: 4, end: 10 }]);
  // The match's line agrees with the row `splitHighlightedLines` puts "two
  // needle\r" on (both are 1-indexed the same way).
  expect(renderedLines[matches[0].line - 1]).toBe("two needle\r");
});
