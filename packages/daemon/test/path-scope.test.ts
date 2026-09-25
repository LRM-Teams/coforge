import { describe, expect, test } from "bun:test";

import { escapePathIdentity, isSafePathScope } from "#src/persistence/path-scope";

test("an ordinary id is a safe scope and passes unchanged through the escaping", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  expect(isSafePathScope(id)).toBe(true);
  expect(escapePathIdentity(id)).toBe(id);
});

test("a separator, a dot, a leading hyphen or a control character is refused as a scope", () => {
  expect(isSafePathScope("a/b")).toBe(false);
  expect(isSafePathScope("a\\b")).toBe(false);
  expect(isSafePathScope(".")).toBe(false);
  expect(isSafePathScope("..")).toBe(false);
  expect(isSafePathScope("a.b")).toBe(false);
  expect(isSafePathScope("-agent")).toBe(false);
  expect(isSafePathScope("a\tb")).toBe(false);
  expect(isSafePathScope("")).toBe(false);
});

test("the grammar is an id of one to 128 alphanumeric or underscore/hyphen characters", () => {
  expect(isSafePathScope("a")).toBe(true);
  expect(isSafePathScope("_-0")).toBe(true);
  expect(isSafePathScope("A".repeat(128))).toBe(true);
  expect(isSafePathScope("A".repeat(129))).toBe(false);
});

test("an escaping turns a traversal-looking identity into a single literal segment", () => {
  expect(escapePathIdentity("..")).toBe("%2E%2E");
  expect(escapePathIdentity("a/b")).toBe("a%2Fb");
  expect(escapePathIdentity("a.b")).toBe("a%2Eb");
  expect(escapePathIdentity("grok 4")).toBe("grok%204");
});
