import { expect, test } from "bun:test";
import { codePointLength, truncateCodePoints } from "./truncate";

test("codePointLength counts an astral character as one, not two UTF-16 units", () => {
  expect(codePointLength("abc")).toBe(3);
  expect(codePointLength("")).toBe(0);
  expect(codePointLength("😀")).toBe(1);
  expect(codePointLength("a😀b")).toBe(3);
});

test("truncateCodePoints returns the string itself when within budget", () => {
  expect(truncateCodePoints("hello", 200)).toBe("hello");
  expect(truncateCodePoints("a".repeat(200), 200)).toBe("a".repeat(200));
});

test("truncateCodePoints budgets emoji as one code point and never splits a pair", () => {
  expect(truncateCodePoints("😀".repeat(300), 200)).toBe("😀".repeat(200));
  const truncated = truncateCodePoints(`${"a".repeat(199)}😀😀`, 200);
  expect(truncated).toBe(`${"a".repeat(199)}😀`);
  expect(codePointLength(truncated)).toBe(200);
  // No lone surrogates: spreading and rejoining round-trips exactly.
  expect([...truncated].join("")).toBe(truncated);
});
